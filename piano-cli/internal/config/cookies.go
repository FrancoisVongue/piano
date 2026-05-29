// Package config owns the on-disk piece of CLI state. In V1 that's
// exactly one file: the cookie jar populated by `piano login` and replayed
// on every host-side backend call. Everything else (endpoints, SSH host
// port) is hard-coded — V1 is a single local daemon, no surface to
// configure.
package config

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
)

func dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(base, "piano")
	return d, os.MkdirAll(d, 0o700)
}

func cookiesPath() (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "cookies.json"), nil
}

// SaveCookies persists the cookies the jar currently holds for `endpoint`.
// We only ever talk to one backend per session — dumping that origin's
// cookies is sufficient.
func SaveCookies(jar http.CookieJar, endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	p, err := cookiesPath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(jar.Cookies(u), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}

// LoadCookies hydrates the jar from the on-disk file, no-op if absent
// (first invocation, not-yet-logged-in).
func LoadCookies(jar http.CookieJar, endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	p, err := cookiesPath()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var cookies []*http.Cookie
	if err := json.Unmarshal(data, &cookies); err != nil {
		return err
	}
	jar.SetCookies(u, cookies)
	return nil
}

// ClearCookies deletes the jar file. Used by `piano logout`.
func ClearCookies() error {
	p, err := cookiesPath()
	if err != nil {
		return err
	}
	err = os.Remove(p)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
