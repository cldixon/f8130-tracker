package commitment

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"fmt"
)

// NonceLength is fixed at 32 CSPRNG bytes per field.
//
// Non-negotiable. 8130-3 fields are extremely low entropy — a status is one of
// five values, a quantity is usually 1 — so an unsalted commitment is
// brute-forced essentially instantly by anyone holding the root.
const NonceLength = 32

// Domain separation prefixes. Without them a leaf and an internal node are
// drawn from the same space and an internal node can be presented as a leaf,
// which is the classic Merkle second-preimage attack.
const (
	LeafPrefix byte = 0x00
	NodePrefix byte = 0x01
	PadPrefix  byte = 0x02
)

func sha256Of(parts ...[]byte) []byte {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// PadLeaf is the constant used to bring the leaf count to a power of two.
func PadLeaf() []byte { return sha256Of([]byte{PadPrefix}) }

// GenerateNonce draws one 32-byte nonce from the CSPRNG.
func GenerateNonce() ([]byte, error) {
	n := make([]byte, NonceLength)
	if _, err := rand.Read(n); err != nil {
		return nil, err
	}
	return n, nil
}

// GenerateNonces draws one nonce per committed field.
func GenerateNonces() ([][]byte, error) {
	out := make([][]byte, len(Fields))
	for i := range out {
		n, err := GenerateNonce()
		if err != nil {
			return nil, err
		}
		out[i] = n
	}
	return out, nil
}

// LeafHash computes SHA256(0x00 ‖ cbor(name) ‖ cbor(value) ‖ nonce).
func LeafHash(name string, value Value, nonce []byte) ([]byte, error) {
	if len(nonce) != NonceLength {
		return nil, fmt.Errorf("nonce must be %d bytes, got %d", NonceLength, len(nonce))
	}
	enc, err := EncodeValue(value)
	if err != nil {
		return nil, err
	}
	return sha256Of([]byte{LeafPrefix}, mustEncode(name), enc, nonce), nil
}

// NodeHash computes SHA256(0x01 ‖ left ‖ right).
func NodeHash(left, right []byte) []byte {
	return sha256Of([]byte{NodePrefix}, left, right)
}

func nextPowerOfTwo(n int) int {
	p := 1
	for p < n {
		p *= 2
	}
	return p
}

// BuildLevels returns every level of the tree, leaves first. The final level
// holds the single root.
func BuildLevels(leaves [][]byte) ([][][]byte, error) {
	if len(leaves) == 0 {
		return nil, fmt.Errorf("cannot build a tree with no leaves")
	}

	padded := make([][]byte, len(leaves))
	copy(padded, leaves)
	pad := PadLeaf()
	for len(padded) < nextPowerOfTwo(len(leaves)) {
		padded = append(padded, pad)
	}

	levels := [][][]byte{padded}
	current := padded
	for len(current) > 1 {
		next := make([][]byte, 0, len(current)/2)
		for i := 0; i < len(current); i += 2 {
			next = append(next, NodeHash(current[i], current[i+1]))
		}
		levels = append(levels, next)
		current = next
	}
	return levels, nil
}

// Commitment is a committed form plus everything needed to reopen it.
type Commitment struct {
	Root    []byte
	Leaves  [][]byte
	Nonces  [][]byte
	Values  Form
	Version int
}

// CommitForm canonicalizes and commits a raw form.
func CommitForm(raw map[string]any, nonces [][]byte) (*Commitment, error) {
	values, err := CanonicalizeForm(raw)
	if err != nil {
		return nil, err
	}
	return CommitCanonicalForm(values, nonces)
}

// CommitCanonicalForm commits an already-canonical form. Passing nil nonces
// draws fresh ones.
func CommitCanonicalForm(values Form, nonces [][]byte) (*Commitment, error) {
	if nonces == nil {
		var err error
		if nonces, err = GenerateNonces(); err != nil {
			return nil, err
		}
	}
	if len(nonces) != len(Fields) {
		return nil, fmt.Errorf("expected %d nonces, got %d", len(Fields), len(nonces))
	}

	leaves := make([][]byte, len(Fields))
	for i, spec := range Fields {
		leaf, err := LeafHash(spec.Name, values[spec.Name], nonces[i])
		if err != nil {
			return nil, err
		}
		leaves[i] = leaf
	}

	levels, err := BuildLevels(leaves)
	if err != nil {
		return nil, err
	}

	return &Commitment{
		Root:    levels[len(levels)-1][0],
		Leaves:  leaves,
		Nonces:  nonces,
		Values:  values,
		Version: FieldSetVersion,
	}, nil
}

// ProofStep is one step up the tree: a sibling hash and the side it sits on.
type ProofStep struct {
	Hash []byte
	Side string // "left" or "right"
}

// FieldProof is a selective disclosure of exactly one field.
type FieldProof struct {
	Field string
	Value Value
	Nonce []byte
	Index int
	Path  []ProofStep
}

// ProofForField builds a selective disclosure for one field.
func ProofForField(c *Commitment, field string) (*FieldProof, error) {
	idx := IndexOf(field)
	if idx < 0 {
		return nil, fmt.Errorf("unknown field: %s", field)
	}
	levels, err := BuildLevels(c.Leaves)
	if err != nil {
		return nil, err
	}

	path := make([]ProofStep, 0, len(levels)-1)
	i := idx
	for level := 0; level < len(levels)-1; level++ {
		side := "right"
		if i&1 == 1 {
			// our own index is odd, so the sibling is to our left
			side = "left"
		}
		path = append(path, ProofStep{Hash: levels[level][i^1], Side: side})
		i >>= 1
	}

	return &FieldProof{
		Field: field,
		Value: c.Values[field],
		Nonce: c.Nonces[idx],
		Index: idx,
		Path:  path,
	}, nil
}

// RootFromProof recomputes a root from a single field proof.
func RootFromProof(p *FieldProof) ([]byte, error) {
	hash, err := LeafHash(p.Field, p.Value, p.Nonce)
	if err != nil {
		return nil, err
	}
	for _, step := range p.Path {
		if step.Side == "left" {
			hash = NodeHash(step.Hash, hash)
		} else {
			hash = NodeHash(hash, step.Hash)
		}
	}
	return hash, nil
}

// VerifyFieldProof checks a selective disclosure against a root.
func VerifyFieldProof(p *FieldProof, root []byte) bool {
	got, err := RootFromProof(p)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, root) == 1
}

// base32Lower is RFC 4648 base32, lowercase and unpadded — the multibase 'b'
// alphabet used for CIDv1 string forms.
var base32Lower = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").
	WithPadding(base32.NoPadding)

// CidForValue computes the CIDv1 (dag-cbor, sha2-256) of a value, matching
// what a PDS assigns to a record.
func CidForValue(v any) (string, error) {
	enc, err := EncodeValue(v)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(enc)

	// CIDv1 ‖ dag-cbor (0x71) ‖ sha2-256 (0x12) ‖ length 32 (0x20) ‖ digest
	raw := append([]byte{0x01, 0x71, 0x12, 0x20}, digest[:]...)
	return "b" + base32Lower.EncodeToString(raw), nil
}
