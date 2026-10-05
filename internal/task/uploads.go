package task

import (
	"errors"
	"io/fs"
	"os"
	"path"
	"strings"
	"unicode/utf8"
)

const maxFileBytes = 64 << 10
const maxWorkspaceBytes = 512 << 10
const maxWorkspaceFiles = 32

type FileInput struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func validPath(name string) bool {
	if name == "" || len(name) > 240 || path.IsAbs(name) || path.Clean(name) != name || strings.ContainsAny(name, "\\:\x00\r\n") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		lower := strings.ToLower(part)
		if part == "" || strings.HasPrefix(part, ".") || lower == "secrets" || lower == "credentials" || strings.HasSuffix(lower, ".pem") || strings.HasSuffix(lower, ".key") {
			return false
		}
	}
	return true
}

func validateUploads(files []FileInput) error {
	if len(files) > maxWorkspaceFiles {
		return errors.New("最多上传 32 个文本文件")
	}
	seen, total := map[string]bool{}, 0
	for _, file := range files {
		if !validPath(file.Path) || seen[strings.ToLower(file.Path)] {
			return errors.New("文件路径无效或重复；不接受隐藏文件和凭据文件")
		}
		seen[strings.ToLower(file.Path)] = true
		total += len(file.Content)
		if len(file.Content) > maxFileBytes || !utf8.ValidString(file.Content) || strings.ContainsRune(file.Content, 0) {
			return errors.New("每个文件须为 UTF-8 文本，最大 64 KiB")
		}
	}
	if total > maxWorkspaceBytes {
		return errors.New("上传文件总大小不得超过 512 KiB")
	}
	return nil
}

func writeUpload(root *os.Root, file FileInput) error {
	if err := root.MkdirAll(path.Dir(file.Path), 0700); err != nil {
		return err
	}
	h, err := root.OpenFile(file.Path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("文件已存在或无法创建")
	}
	_, err = h.WriteString(file.Content)
	if err == nil {
		err = h.Sync()
	}
	closeErr := h.Close()
	if err == nil {
		err = closeErr
	}
	return err
}

func (f *Files) List() ([]string, error) {
	if f.local != nil {
		return f.listLocal()
	}
	if !f.generic {
		return []string{"pricing.json", "pricing.test.json"}, nil
	}
	names := []string{}
	err := fs.WalkDir(f.root.FS(), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if name == "." {
			return nil
		}
		if !validPath(name) {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type().IsRegular() {
			names = append(names, name)
		}
		if len(names) > maxWorkspaceFiles {
			return errors.New("workspace file limit exceeded")
		}
		return nil
	})
	return names, err
}

func (s *Service) FileList(id string) ([]string, error) {
	f, err := s.files(id)
	if err != nil {
		return nil, err
	}
	defer f.root.Close()
	return f.List()
}
