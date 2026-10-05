//go:build !windows

package task

import (
	"os"
	"syscall"
)

func hasMultipleLinks(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return true
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return !ok || stat.Nlink > 1
}
