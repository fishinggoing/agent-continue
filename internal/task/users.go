package task

import (
	"context"

	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/session"
)

// UserService is the boundary for requests from an authenticated user.
// Session ownership is immutable, so authorization remains valid during a call.
type UserService struct {
	service *Service
	owner   string
}

func (s *Service) ForUser(owner string) UserService { return UserService{service: s, owner: owner} }

func (u UserService) authorize(id string) error {
	u.service.mu.Lock()
	defer u.service.mu.Unlock()
	snap := u.service.sessions[id]
	if u.service.local || u.owner == "" || snap == nil || snap.OwnerID != u.owner {
		return ErrNotFound
	}
	return nil
}

func (u UserService) List() []Snapshot {
	result := []Snapshot{}
	if u.service.local {
		return result
	}
	for _, snap := range u.service.List() {
		if u.owner != "" && snap.OwnerID == u.owner {
			result = append(result, snap)
		}
	}
	return result
}

func (u UserService) StartWithFiles(ctx context.Context, req domain.StartRequest, files []FileInput) (domain.Run, error) {
	return u.service.startWithFiles(ctx, u.owner, req, files)
}

func (u UserService) Get(id string) (Snapshot, error) {
	if err := u.authorize(id); err != nil {
		return Snapshot{}, err
	}
	return u.service.Get(id)
}

func (u UserService) ContinueWithFiles(ctx context.Context, id, prompt string, files []FileInput) (domain.Run, error) {
	if err := u.authorize(id); err != nil {
		return domain.Run{}, err
	}
	return u.service.ContinueWithFiles(ctx, id, prompt, files)
}

func (u UserService) Cancel(ctx context.Context, id string) error {
	if err := u.authorize(id); err != nil {
		return err
	}
	return u.service.Cancel(ctx, id)
}

func (u UserService) Resolve(id string, decision domain.ApprovalDecision) error {
	if err := u.authorize(id); err != nil {
		return err
	}
	return u.service.Resolve(id, decision)
}

func (u UserService) File(id, path string) (string, error) {
	if err := u.authorize(id); err != nil {
		return "", err
	}
	return u.service.File(id, path)
}

func (u UserService) FileList(id string) ([]string, error) {
	if err := u.authorize(id); err != nil {
		return nil, err
	}
	return u.service.FileList(id)
}

func (u UserService) Events(ctx context.Context, id string, after uint64) (<-chan domain.Event, error) {
	if err := u.authorize(id); err != nil {
		return nil, err
	}
	return u.service.Events(ctx, id, after)
}

func (s *Service) CreateUser(ctx context.Context, name string) (session.User, string, error) {
	return s.store.CreateUser(ctx, name)
}

func (s *Service) User(ctx context.Context, id string) (session.User, error) {
	return s.store.User(ctx, id)
}

func (s *Service) AuthenticateUser(ctx context.Context, token string) (session.User, error) {
	return s.store.AuthenticateUser(ctx, token)
}

func (s *Service) Users(ctx context.Context) ([]session.User, error) {
	return s.store.Users(ctx)
}

func (s *Service) RevokeUser(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.RevokeUser(ctx, id); err != nil {
		return err
	}
	for sessionID, active := range s.active {
		if s.sessions[sessionID].OwnerID == id {
			active.cancel()
		}
	}
	return nil
}
