// Package auth carries the authenticated user id through request contexts.
package auth

import (
	"context"
	"net/http"
)

type ctxKey struct{}

func WithUser(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// UserID returns the authenticated user, or "" for anonymous requests.
func UserID(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

// Dev authenticates every request as one fixed user. M1 only; M3 replaces it with sessions.
func Dev(userID string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), userID)))
	})
}
