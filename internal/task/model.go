package task

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"

	"github.com/fishinggoing/agent-continue/internal/config"
	"github.com/fishinggoing/agent-continue/internal/domain"
	"github.com/fishinggoing/agent-continue/internal/provider"
)

// Private settings never appear in snapshots, events, exports or HTTP responses.
type modelSettings struct {
	Model string `json:"model"`
	Key   string `json:"apiKey"`
}

func selectModel(c config.Config, model string) config.Config {
	p := &c.Provider
	if model == "gpt-6.1-sol" {
		if p.ID != "hyperion" {
			p.Endpoint = "https://atropos.top/v1/responses"
		}
		p.ID, p.Protocol, p.CredentialEnv, p.ReasoningEffort = "hyperion", config.ProtocolResponses, "HYPERION_API_KEY", "xhigh"
		p.TimeoutSeconds = 240
	} else {
		if p.ID != "deepseek" {
			p.Endpoint = "https://api.deepseek.com/chat/completions"
		}
		p.ID, p.Protocol, p.CredentialEnv, p.ReasoningEffort = "deepseek", config.ProtocolDeepSeek, "DEEPSEEK_API_KEY", ""
	}
	p.Model = model
	return c
}

func (s *Service) credentialLocked() (string, error) {
	if s.modelKey != "" {
		return s.modelKey, nil
	}
	if s.local {
		return "", errors.New("model credential environment variable is not set")
	}
	return config.Credential(s.config.Provider, os.LookupEnv)
}

func (s *Service) loadModelSettings() error {
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	info, err := root.Lstat("model-settings.json")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 8192 {
		return errors.New("invalid private model settings file")
	}
	f, err := root.Open("model-settings.json")
	if err != nil {
		return errors.New("cannot read private model settings")
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 8193))
	var settings modelSettings
	if err != nil || strictJSON(b, &settings) != nil {
		return errors.New("invalid private model settings")
	}
	c := selectModel(s.config, settings.Model)
	if config.Validate(c) != nil || validateKey(settings.Key) != nil {
		return errors.New("invalid private model settings")
	}
	s.config, s.modelKey = c, settings.Key
	return nil
}

func validateKey(key string) error {
	if len(key) > 4096 || strings.ContainsAny(key, " \t\r\n\x00") {
		return errors.New("API Key 格式无效")
	}
	for _, char := range key {
		if char < 33 || char > 126 {
			return errors.New("API Key 格式无效")
		}
	}
	return nil
}

func (s *Service) ConfigureModel(model, key string) error {
	if s.local {
		return errors.New("local model settings must be supplied through configuration and environment")
	}
	key = strings.TrimSpace(key)
	if err := validateKey(key); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("service is closing")
	}
	c := selectModel(s.config, model)
	if err := config.Validate(c); err != nil {
		return err
	}
	if key == "" && c.Provider.ID == s.config.Provider.ID {
		key = s.modelKey
	}
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return errors.New("cannot open private settings directory")
	}
	defer root.Close()
	name := ".model-" + newID() + ".tmp"
	f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("cannot save private model settings")
	}
	defer root.Remove(name)
	b, _ := json.Marshal(modelSettings{Model: model, Key: key})
	if len(b) > 8192 {
		f.Close()
		return errors.New("private model settings exceed size limit")
	}
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = root.Rename(name, "model-settings.json")
	}
	if err != nil {
		return errors.New("cannot persist private model settings")
	}
	s.config, s.modelKey = c, key
	return nil
}

func (s *Service) Models() []domain.Model {
	s.mu.Lock()
	defer s.mu.Unlock()
	return provider.Models(s.config.Provider)
}

func (s *Service) CheckModel(ctx context.Context) error {
	s.mu.Lock()
	c := s.config
	key, err := s.credentialLocked()
	s.mu.Unlock()
	if err != nil {
		return errors.New("请先配置模型 API Key")
	}
	c.Provider.MaxRetries = 0
	client, err := provider.Open(c, func(name string) (string, bool) { return key, name == c.Provider.CredentialEnv && key != "" })
	if err != nil {
		return err
	}
	defer client.Close()
	_, err = client.Complete(ctx, domain.ModelRequest{Model: c.Provider.Model, MaxOutputTokens: 1024, Messages: []domain.Message{{Role: domain.RoleUser, Content: []domain.ContentPart{{Type: "text", Text: "只回复：收到"}}}}}, nil)
	return err
}

func (s *Service) ProviderID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.config.Provider.ID
}
