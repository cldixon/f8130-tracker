package ingest

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	atrepo "github.com/bluesky-social/indigo/atproto/repo"
	"github.com/bluesky-social/indigo/atproto/syntax"
)

// Recovering a station profile that the firehose will not replay.
//
// The problem this exists for. A station record is written once, when an
// organization is provisioned, and never again. The firehose is a log of
// changes, so a profile is a single event near the beginning of it — and a
// rebuilt index replays only what the server still holds. Reindex twice and
// every display name in the application is gone for good, which is what
// happened: receivers rendered as identifiers because nothing in the index
// knew their names any more.
//
// The fix is to stop treating a profile as an event. It is current state, and
// current state is fetchable: com.atproto.sync.getRecord returns the record
// together with the proof path and the signed commit at its root. So the
// observer asks for it directly the first time it notices it is missing one,
// and an index rebuilt from nothing repairs itself without anybody rerunning
// a seed job.
//
// It is fetched over the *sync* endpoint rather than com.atproto.repo.get-
// Record, which would have been three lines shorter and would have meant
// believing a server's word about what a repository contains. This service
// verifies every commit it takes off the firehose; taking profile data on
// trust through a side door would leave the claim "nothing here is believed
// without a signature" false in a way nobody would notice.

const stationRkey = "self"

// httpBase converts the configured firehose host into an ordinary HTTP origin.
//
// The host is stored as a websocket URL because subscribing is what it is
// mostly for. Everything else about it — scheme aside — is the same server.
func httpBase(host string) (string, error) {
	u, err := url.Parse(host)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "ws", "http":
		u.Scheme = "http"
	case "wss", "https":
		u.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported host scheme: %q", u.Scheme)
	}
	u.Path = ""
	u.RawQuery = ""
	return strings.TrimRight(u.String(), "/"), nil
}

// fetchStation asks a repository for its own profile and verifies the answer.
//
// The CAR that comes back carries the record, the MST nodes proving it is in
// the tree, and the commit at the root. Verifying the commit signature against
// the DID's declared key is what makes this evidence rather than a claim: the
// server relaying it cannot have written it and cannot have altered it.
func (c *Consumer) fetchStation(ctx context.Context, repoDID string) (*Station, error) {
	did, err := syntax.ParseDID(repoDID)
	if err != nil {
		return nil, err
	}
	base, err := httpBase(c.Host)
	if err != nil {
		return nil, err
	}

	endpoint := fmt.Sprintf(
		"%s/xrpc/com.atproto.sync.getRecord?did=%s&collection=%s&rkey=%s",
		base, url.QueryEscape(did.String()), url.QueryEscape(StationNSID), stationRkey,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// A 404 is the ordinary answer for an organization that has never
		// published a profile, and is not an error worth shouting about.
		return nil, fmt.Errorf("sync.getRecord: %s", resp.Status)
	}

	// Bounded, because this is a remote server deciding how much to send.
	car, err := io.ReadAll(io.LimitReader(resp.Body, maxProofBytes))
	if err != nil {
		return nil, err
	}

	if _, err := atrepo.VerifyCommitSignatureFromCar(ctx, c.Directory, car); err != nil {
		return nil, fmt.Errorf("commit signature did not verify: %w", err)
	}
	_, repo, err := atrepo.LoadRepoFromCAR(ctx, strings.NewReader(string(car)))
	if err != nil {
		return nil, fmt.Errorf("load proof: %w", err)
	}

	nsid, err := syntax.ParseNSID(StationNSID)
	if err != nil {
		return nil, err
	}
	raw, _, err := repo.GetRecordBytes(ctx, nsid, stationRkey)
	if err != nil {
		return nil, fmt.Errorf("record absent from its own proof: %w", err)
	}

	decoded, err := DecodeRecord(StationNSID, raw)
	if err != nil {
		return nil, err
	}
	st, ok := decoded.(*Station)
	if !ok {
		return nil, fmt.Errorf("not a station record")
	}
	return st, nil
}

// maxProofBytes caps a single record's proof. One record, its path to the
// root and a commit is kilobytes; anything approaching this is a server
// answering a different question.
const maxProofBytes = 4 << 20
