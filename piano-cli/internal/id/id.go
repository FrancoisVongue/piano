// Package id mints fresh machine IDs client-side. The daemon doesn't
// require any particular format — only uniqueness — so we use a short
// lowercase base32 string. 8 bytes of entropy → 13 chars, plenty for
// the foreseeable machine count per user.
package id

import (
	"crypto/rand"
	"encoding/base32"
	"strings"
)

func New() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand reads cannot fail on Linux; if they do, we have bigger
		// problems than CLI determinism. Panic so the user retries.
		panic("crypto/rand failed: " + err.Error())
	}
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:]))
}
