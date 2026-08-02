package commitment

import (
	"encoding/binary"
	"fmt"
	"sort"
)

// Minimal deterministic DAG-CBOR encoder.
//
// Only the subset the commitment scheme actually needs: null, integers, text
// strings, byte strings, and maps. Deliberately not a general CBOR library —
// a general one would accept indefinite lengths, non-shortest integer forms,
// and floats, every one of which would break determinism. Encoding exactly
// what is needed and refusing everything else is the point.
//
// Floats are absent entirely rather than rejected at runtime: there is no code
// path that can emit one.

func encodeHead(major byte, n uint64) []byte {
	switch {
	case n < 24:
		return []byte{major<<5 | byte(n)}
	case n < 1<<8:
		return []byte{major<<5 | 24, byte(n)}
	case n < 1<<16:
		b := []byte{major<<5 | 25, 0, 0}
		binary.BigEndian.PutUint16(b[1:], uint16(n))
		return b
	case n < 1<<32:
		b := []byte{major<<5 | 26, 0, 0, 0, 0}
		binary.BigEndian.PutUint32(b[1:], uint32(n))
		return b
	default:
		b := []byte{major<<5 | 27, 0, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint64(b[1:], n)
		return b
	}
}

func encodeInt(v int64) []byte {
	if v >= 0 {
		return encodeHead(0, uint64(v))
	}
	// Major type 1 encodes -1-n, so -1 is stored as 0.
	return encodeHead(1, uint64(-(v + 1)))
}

func encodeString(s string) []byte {
	return append(encodeHead(3, uint64(len(s))), s...)
}

func encodeBytes(b []byte) []byte {
	return append(encodeHead(2, uint64(len(b))), b...)
}

// mapKeyLess implements DAG-CBOR's canonical map ordering: shorter keys first,
// then bytewise. Not plain lexicographic — "z" sorts before "aa".
func mapKeyLess(a, b string) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}

// EncodeValue encodes a scalar or map to deterministic DAG-CBOR.
func EncodeValue(v any) ([]byte, error) {
	switch x := v.(type) {
	case nil:
		return []byte{0xf6}, nil
	case string:
		return encodeString(x), nil
	case int:
		return encodeInt(int64(x)), nil
	case int64:
		return encodeInt(x), nil
	case []byte:
		return encodeBytes(x), nil
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return mapKeyLess(keys[i], keys[j]) })

		out := encodeHead(5, uint64(len(keys)))
		for _, k := range keys {
			out = append(out, encodeString(k)...)
			enc, err := EncodeValue(x[k])
			if err != nil {
				return nil, err
			}
			out = append(out, enc...)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("cannot DAG-CBOR encode %T", v)
	}
}

// mustEncode encodes a value known to be encodable (a canonical field value).
func mustEncode(v any) []byte {
	b, err := EncodeValue(v)
	if err != nil {
		panic(err)
	}
	return b
}
