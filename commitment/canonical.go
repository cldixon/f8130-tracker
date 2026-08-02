package commitment

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// jsSpace is ECMAScript's \s character class, spelled out.
//
// Go's own \s is ASCII-only ([\t\n\f\r ]) while JavaScript's includes NBSP,
// the Unicode space separators, the line/paragraph separators, and the BOM.
// Using Go's default would make the two implementations disagree the moment a
// form contained a non-breaking space — pasted out of a spreadsheet, say —
// and the disagreement would surface as an unverifiable document rather than
// as an error.
const jsSpace = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	identifierNoise = regexp.MustCompile(`[` + jsSpace + `\-_/.]+`)
	whitespaceRun   = regexp.MustCompile(`[` + jsSpace + `]+`)

	// RFC 3339 with a mandatory offset, matching the TypeScript side exactly
	// (including the tolerated space separator and lowercase t/z).
	rfc3339 = regexp.MustCompile(
		`^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$`)

	// Full Unicode uppercasing, language-neutral. Matches JavaScript's
	// toUpperCase, which does full case mapping (ß becomes SS); Go's
	// strings.ToUpper does simple per-rune mapping and would leave it alone.
	upper = cases.Upper(language.Und)
)

// Error is a canonicalization failure naming the offending field.
type Error struct {
	Field   string
	Message string
}

func (e *Error) Error() string { return e.Field + ": " + e.Message }

func errf(field, format string, args ...any) *Error {
	return &Error{Field: field, Message: fmt.Sprintf(format, args...)}
}

// NormalizeIdentifier applies NFC, strips separators, and uppercases.
func NormalizeIdentifier(v string) string {
	return upper.String(identifierNoise.ReplaceAllString(norm.NFC.String(v), ""))
}

// NormalizeText applies NFC, collapses internal whitespace runs to a single
// space, and trims.
//
// Trimming plain ASCII spaces is sufficient: the collapse has already
// rewritten every exotic space to U+0020.
func NormalizeText(v string) string {
	return strings.Trim(whitespaceRun.ReplaceAllString(norm.NFC.String(v), " "), " ")
}

// NormalizeTimestamp forces RFC 3339 input to UTC at second precision.
func NormalizeTimestamp(field, v string) (string, error) {
	trimmed := strings.TrimSpace(v)
	m := rfc3339.FindStringSubmatch(trimmed)
	if m == nil {
		return "", errf(field, "expected RFC 3339 with a UTC offset, got %q", v)
	}

	// Normalize the tolerated spellings before handing to the strict parser.
	normalized := trimmed
	if normalized[10] != 'T' {
		normalized = normalized[:10] + "T" + normalized[11:]
	}
	normalized = strings.Replace(normalized, "z", "Z", 1)

	// Go's parser validates the calendar date and rejects a seconds value of
	// 60, so impossible dates and leap seconds both fail here rather than
	// silently rolling forward into a date nobody typed.
	t, err := time.Parse(time.RFC3339, normalized)
	if err != nil {
		return "", errf(field, "not a valid date: %q", v)
	}

	return t.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z"), nil
}

// NormalizeEnum validates a value against a closed set.
func NormalizeEnum(spec FieldSpec, v string) (string, error) {
	u := upper.String(strings.TrimSpace(norm.NFC.String(v)))
	for _, allowed := range spec.Values {
		if u == allowed {
			return u, nil
		}
	}
	return "", errf(spec.Name, "expected one of %s, got %q",
		strings.Join(spec.Values, ", "), v)
}

// CanonicalizeField canonicalizes a single raw value.
//
// Raw values arrive as nil, string, or an integer type. Floats are refused
// outright: money is integer cents, and rounding a caller's number silently
// would commit to a figure they never wrote.
func CanonicalizeField(spec FieldSpec, raw any) (Value, error) {
	if raw == nil {
		return nil, nil
	}

	if spec.Kind == KindInteger {
		switch n := raw.(type) {
		case int:
			return int64(n), nil
		case int64:
			return n, nil
		case float64:
			if n != float64(int64(n)) {
				return nil, errf(spec.Name,
					"expected an integer, got %v — money is integer cents, never a float", n)
			}
			return int64(n), nil
		default:
			return nil, errf(spec.Name, "expected a number, got %T", raw)
		}
	}

	s, ok := raw.(string)
	if !ok {
		return nil, errf(spec.Name, "expected a string for this field, got %T", raw)
	}

	switch spec.Kind {
	case KindIdentifier:
		return NormalizeIdentifier(s), nil
	case KindText:
		return NormalizeText(s), nil
	case KindTimestamp:
		return NormalizeTimestamp(spec.Name, s)
	case KindEnum:
		return NormalizeEnum(spec, s)
	}
	return nil, errf(spec.Name, "unhandled field kind")
}

// CanonicalizeForm canonicalizes a raw form into the fixed field set.
//
// Every field is always present in the result, explicitly nil when absent, so
// the tree has a constant shape for every form ever issued. Unknown keys are
// rejected rather than ignored: silently dropping a field the caller believed
// they were committing to is the worst available failure.
func CanonicalizeForm(raw map[string]any) (Form, error) {
	for k := range raw {
		if IndexOf(k) < 0 {
			return nil, errf(k, "not part of the committed field set (v%d)", FieldSetVersion)
		}
	}

	out := make(Form, len(Fields))
	for _, spec := range Fields {
		v, err := CanonicalizeField(spec, raw[spec.Name])
		if err != nil {
			return nil, err
		}
		out[spec.Name] = v
	}
	return out, nil
}
