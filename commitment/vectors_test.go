package commitment

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The Go implementation is only worth having if it agrees with the TypeScript
// one byte for byte. These tests are that agreement, and they are the reason
// the scheme can be called independently implementable.

type vectorDoc struct {
	FieldSetVersion int      `json:"fieldSetVersion"`
	FieldOrder      []string `json:"fieldOrder"`
	NonceLength     int      `json:"nonceLength"`
	Prefixes        struct {
		Leaf byte `json:"leaf"`
		Node byte `json:"node"`
		Pad  byte `json:"pad"`
	} `json:"prefixes"`
	PadLeaf string `json:"padLeaf"`
	Lexicon string `json:"lexicon"`
	Vectors []struct {
		Name      string         `json:"name"`
		IssuerDid string         `json:"issuerDid"`
		Input     map[string]any `json:"input"`
		Canonical map[string]any `json:"canonical"`
		Nonces    []string       `json:"nonces"`
		Leaves    []string       `json:"leaves"`
		Root      string         `json:"root"`
		RecordCid string         `json:"recordCid"`
		Proof     struct {
			Field string `json:"field"`
			Value any    `json:"value"`
			Index int    `json:"index"`
			Nonce string `json:"nonce"`
			Path  []struct {
				Hash string `json:"hash"`
				Side string `json:"side"`
			} `json:"path"`
		} `json:"proof"`
	} `json:"vectors"`
}

// numbersToInt64 rewrites json.Number into int64 so the commitment code sees
// exact integers. A non-integral number is left as float64 so canonicalization
// rejects it, rather than being silently truncated here.
func numbersToInt64(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		f, _ := x.Float64()
		return f
	case map[string]any:
		for k, val := range x {
			x[k] = numbersToInt64(val)
		}
		return x
	default:
		return v
	}
}

func loadVectors(t *testing.T) *vectorDoc {
	t.Helper()
	path := filepath.Join("..", "testdata", "vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc vectorDoc
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	for i := range doc.Vectors {
		doc.Vectors[i].Input = numbersToInt64(doc.Vectors[i].Input).(map[string]any)
		doc.Vectors[i].Canonical = numbersToInt64(doc.Vectors[i].Canonical).(map[string]any)
		doc.Vectors[i].Proof.Value = numbersToInt64(doc.Vectors[i].Proof.Value)
	}
	return &doc
}

func TestFieldSetMetadata(t *testing.T) {
	doc := loadVectors(t)

	if doc.FieldSetVersion != FieldSetVersion {
		t.Errorf("field set version: vectors say %d, implementation says %d",
			doc.FieldSetVersion, FieldSetVersion)
	}
	if doc.NonceLength != NonceLength {
		t.Errorf("nonce length: vectors say %d, implementation says %d",
			doc.NonceLength, NonceLength)
	}
	if doc.Prefixes.Leaf != LeafPrefix || doc.Prefixes.Node != NodePrefix || doc.Prefixes.Pad != PadPrefix {
		t.Error("domain separation prefixes disagree with the vectors")
	}

	order := FieldOrder()
	if len(order) != len(doc.FieldOrder) {
		t.Fatalf("field count: vectors say %d, implementation says %d",
			len(doc.FieldOrder), len(order))
	}
	for i := range order {
		if order[i] != doc.FieldOrder[i] {
			t.Errorf("field %d: vectors say %q, implementation says %q",
				i, doc.FieldOrder[i], order[i])
		}
	}

	if got := hex.EncodeToString(PadLeaf()); got != doc.PadLeaf {
		t.Errorf("pad leaf: got %s, want %s", got, doc.PadLeaf)
	}
}

func TestVectors(t *testing.T) {
	doc := loadVectors(t)

	for _, v := range doc.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			nonces := make([][]byte, len(v.Nonces))
			for i, n := range v.Nonces {
				b, err := hex.DecodeString(n)
				if err != nil {
					t.Fatalf("nonce %d: %v", i, err)
				}
				nonces[i] = b
			}

			c, err := CommitForm(v.Input, nonces)
			if err != nil {
				t.Fatalf("commit: %v", err)
			}

			// canonical values
			for name, want := range v.Canonical {
				got := c.Values[name]
				if !valueEqual(got, want) {
					t.Errorf("canonical %s: got %#v, want %#v", name, got, want)
				}
			}

			// per-leaf, so a mismatch names the field rather than just the root
			for i, want := range v.Leaves {
				if got := hex.EncodeToString(c.Leaves[i]); got != want {
					t.Errorf("leaf %d (%s): got %s, want %s", i, Fields[i].Name, got, want)
				}
			}

			if got := hex.EncodeToString(c.Root); got != v.Root {
				t.Errorf("root: got %s, want %s", got, v.Root)
			}

			// the record CID pins the DAG-CBOR encoding of the record itself,
			// not merely the tree.
			//
			// Assembled by walking Fields rather than naming them, because a
			// restated list is how a record drifts away from its field set:
			// this one went on naming `status` after status stopped being
			// public, and only the CID caught it.
			record := map[string]any{
				"$type":           doc.Lexicon,
				"commitment":      c.Root,
				"fieldSetVersion": int64(FieldSetVersion),
				"issuerDid":       v.IssuerDid,
			}
			for _, f := range Fields {
				if !f.Public {
					continue
				}
				if val := c.Values[f.Name]; val != nil {
					record[f.Name] = val
				}
			}
			cid, err := CidForValue(record)
			if err != nil {
				t.Fatalf("cid: %v", err)
			}
			if cid != v.RecordCid {
				t.Errorf("record cid: got %s, want %s", cid, v.RecordCid)
			}

			// the worked selective-disclosure proof
			nonce, err := hex.DecodeString(v.Proof.Nonce)
			if err != nil {
				t.Fatalf("proof nonce: %v", err)
			}
			path := make([]ProofStep, len(v.Proof.Path))
			for i, s := range v.Proof.Path {
				h, err := hex.DecodeString(s.Hash)
				if err != nil {
					t.Fatalf("proof path %d: %v", i, err)
				}
				path[i] = ProofStep{Hash: h, Side: s.Side}
			}
			root, err := hex.DecodeString(v.Root)
			if err != nil {
				t.Fatal(err)
			}
			proof := &FieldProof{
				Field: v.Proof.Field,
				Value: v.Proof.Value,
				Nonce: nonce,
				Index: v.Proof.Index,
				Path:  path,
			}
			if !VerifyFieldProof(proof, root) {
				t.Error("selective disclosure proof from the vectors did not verify")
			}

			// and the same proof rebuilt locally
			local, err := ProofForField(c, v.Proof.Field)
			if err != nil {
				t.Fatalf("build proof: %v", err)
			}
			if !VerifyFieldProof(local, c.Root) {
				t.Error("locally built proof did not verify")
			}
		})
	}
}

func valueEqual(got, want any) bool {
	if got == nil || want == nil {
		return got == nil && want == nil
	}
	switch g := got.(type) {
	case string:
		w, ok := want.(string)
		return ok && g == w
	case int64:
		w, ok := want.(int64)
		return ok && g == w
	}
	return false
}
