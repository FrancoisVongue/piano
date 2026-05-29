package api

// Better-auth endpoints. Bodies/responses are better-auth's native shape,
// NOT the {success: T} envelope the rest of the backend uses — these go
// through doRaw, not do.

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name,omitempty"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type LoginResponse struct {
	User User `json:"user"`
}

type SessionResponse struct {
	User    *User `json:"user,omitempty"`
	Session any   `json:"session,omitempty"`
}

func (c *Client) Login(email, password string) (LoginResponse, error) {
	return doRaw[LoginResponse](c, "POST", "/api/auth/sign-in/email", LoginRequest{
		Email:    email,
		Password: password,
	})
}

func (c *Client) Logout() error {
	return doVoid(c, "POST", "/api/auth/sign-out", nil)
}

// Whoami returns the current session, or User=nil if not logged in —
// better-auth answers 200 with {user: null} for absent/expired sessions,
// not 401, so callers don't need to special-case that path.
func (c *Client) Whoami() (SessionResponse, error) {
	return doRaw[SessionResponse](c, "GET", "/api/auth/get-session", nil)
}
