//go:build windows

package task

import (
	"os"
	"syscall"
)

func hasMultipleLinks(f *os.File) bool {
	var info syscall.ByHandleFileInformation
	return syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info) != nil || info.NumberOfLinks > 1
}
