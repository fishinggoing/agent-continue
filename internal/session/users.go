package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

const DefaultOwnerID = "owner"

type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Admin bool   `json:"admin"`
}

func tokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func (s *Store) User(ctx context.Context, id string) (User, error) {
	var user User
	err := s.db.QueryRowContext(ctx, "SELECT id, name FROM users WHERE id=?", id).Scan(&user.ID, &user.Name)
	return user, err
}

func (s *Store) AuthenticateUser(ctx context.Context, token string) (User, error) {
	var user User
	err := s.db.QueryRowContext(ctx, "SELECT id, name FROM users WHERE token_hash=?", tokenHash(token)).Scan(&user.ID, &user.Name)
	return user, err
}

func (s *Store) Users(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, name FROM users ORDER BY name")
	if err != nil {
		return nil, errors.New("cannot list users")
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Name); err != nil {
			return nil, errors.New("cannot list users")
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) RevokeUser(ctx context.Context, id string) error {
	if id == "" || id == DefaultOwnerID {
		return errors.New("cannot revoke the service administrator")
	}
	result, err := s.db.ExecContext(ctx, "DELETE FROM users WHERE id=?", id)
	if err != nil {
		return errors.New("cannot revoke user")
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return errors.New("user not found")
	}
	return nil
}

func (s *Store) CreateUser(ctx context.Context, name string) (User, string, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || len([]rune(name)) < 1 || len([]rune(name)) > 48 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return User{}, "", errors.New("user name must contain 1 to 48 characters without control characters")
	}
	id, secret := make([]byte, 16), make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		return User{}, "", err
	}
	if _, err := rand.Read(secret); err != nil {
		return User{}, "", err
	}
	user, token := User{ID: hex.EncodeToString(id), Name: name}, hex.EncodeToString(secret)
	_, err := s.db.ExecContext(ctx, "INSERT INTO users(id,name,token_hash) VALUES(?,?,?)", user.ID, user.Name, tokenHash(token))
	if err != nil {
		return User{}, "", errors.New("cannot create user; choose a unique name")
	}
	return user, token, nil
}
