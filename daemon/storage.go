package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"

	"golang.org/x/sys/unix"
)

const storageImageSize = "50G"
const minLoopDevices = 64

// storageImagePath returns the path to the BTRFS sparse image file.
func storageImagePath() string {
	uid, _, _, _ := hostUser()
	return fmt.Sprintf("/var/tmp/piano_%d.btrfs.img", uid)
}

// EnsureBtrfsStorage creates and mounts a BTRFS sparse image at mountPoint.
// BTRFS provides O(1) subvolume snapshots for instant machine branching.
// The image is a sparse file — physically uses only as much space as the actual data.
// Idempotent: no-op if already mounted.
func EnsureBtrfsStorage(mountPoint string) error {
	if isMounted(mountPoint) {
		log.Printf("[storage] %s already mounted (BTRFS)", mountPoint)
		return nil
	}

	imgPath := storageImagePath()

	if _, err := os.Stat(imgPath); os.IsNotExist(err) {
		log.Printf("[storage] creating %s sparse BTRFS image at %s", storageImageSize, imgPath)

		out, err := exec.Command("truncate", "-s", storageImageSize, imgPath).CombinedOutput()
		if err != nil {
			return fmt.Errorf("truncate: %w\noutput: %s", err, out)
		}

		out, err = exec.Command("mkfs.btrfs", "-f", imgPath).CombinedOutput()
		if err != nil {
			os.Remove(imgPath)
			return fmt.Errorf("mkfs.btrfs: %w\noutput: %s\nhint: apt install btrfs-progs", err, out)
		}

		log.Printf("[storage] BTRFS image formatted")
	}

	if err := ensureLoopDevices(minLoopDevices); err != nil {
		return err
	}

	os.MkdirAll(mountPoint, 0755)
	out, err := exec.Command("mount", "-o", "loop,autodefrag,compress=zstd", imgPath, mountPoint).CombinedOutput()
	if err != nil {
		return fmt.Errorf("mount BTRFS: %w\noutput: %s", err, out)
	}

	log.Printf("[storage] BTRFS mounted at %s (snapshots + compress=zstd)", mountPoint)
	return nil
}

func ensureLoopDevices(count int) error {
	if err := ensureDeviceNode("/dev/loop-control", unix.S_IFCHR|0660, 10, 237); err != nil {
		return fmt.Errorf("ensure /dev/loop-control: %w", err)
	}
	for i := 0; i < count; i++ {
		if err := ensureDeviceNode(fmt.Sprintf("/dev/loop%d", i), unix.S_IFBLK|0660, 7, uint32(i)); err != nil {
			return fmt.Errorf("ensure /dev/loop%d: %w", i, err)
		}
	}
	log.Printf("[storage] loop devices ready (/dev/loop0..%d)", count-1)
	return nil
}

func ensureDeviceNode(path string, mode uint32, major uint32, minor uint32) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	err := unix.Mknod(path, mode, int(unix.Mkdev(major, minor)))
	if err != nil && !errors.Is(err, unix.EEXIST) {
		return err
	}
	return nil
}

// UnmountStorage unmounts the BTRFS image. Called during shutdown.
func UnmountStorage(mountPoint string) {
	if isMounted(mountPoint) {
		_ = exec.Command("umount", mountPoint).Run()
		log.Printf("[storage] unmounted %s", mountPoint)
	}
}

// isMounted checks if a path is a mount point.
func isMounted(path string) bool {
	return exec.Command("mountpoint", "-q", path).Run() == nil
}
