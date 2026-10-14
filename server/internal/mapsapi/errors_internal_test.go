package mapsapi

import (
	"errors"
	"strings"
	"testing"
)

// Review fix: spec §4.2 — never echo SQL errors that include server file paths.
func TestQueryErrorRedactsPaths(t *testing.T) {
	err := queryError(errors.New(`Permission Error: Cannot access directory "/Users/pandu/.duckdb/extensions/v1.5.6/osx_arm64"` + "\nLINE 1: ..."))
	if msg := err.Error(); strings.Contains(msg, "/Users") || strings.Contains(msg, ".duckdb") || !strings.Contains(msg, "Permission Error") {
		t.Fatalf("message = %q", msg)
	}
}
