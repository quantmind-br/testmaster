// Command reftui is the reference CLI and TUI program for the terminal runner acceptance (M5-09).
// It uses the standard library only so that it builds offline into one static binary.
//
// Pipe mode: --version, --list, --init, --hang, --watch; any other flag is a usage error.
// PTY mode (no arguments): a full-screen menu on the alternate screen with application cursor
// keys. Down/Up move the selection, Enter copies the selected entry with OSC 52, q quits.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

// sleepForever blocks without leaving the Go runtime with no runnable goroutine, which it
// would report as a deadlock and exit 2.
func sleepForever() {
	for {
		time.Sleep(time.Hour)
	}
}

const version = "1.2.3"

// usageExit is the exit status of an unknown flag.
const usageExit = 2

var entries = []string{"alpha", "beta", "gamma"}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		return menu()
	}
	switch args[0] {
	case "--version":
		fmt.Println("reftui " + version)
		return 0
	case "--list":
		fmt.Fprintln(os.Stderr, "warning: the entry list is static")
		encoded, _ := json.Marshal(map[string]any{"entries": entries, "count": len(entries)})
		fmt.Println(string(encoded))
		return 0
	case "--init":
		if err := os.MkdirAll(".reftui", 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "reftui:", err)
			return 1
		}
		target := filepath.Join(".reftui", "project.json")
		if err := os.WriteFile(target, []byte("{\"name\":\"demo\"}\n"), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "reftui:", err)
			return 1
		}
		fmt.Println("initialised " + target)
		return 0
	case "--hang":
		signal.Ignore(syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
		sleepForever()
	case "--watch":
		self, err := os.Executable()
		if err != nil {
			fmt.Fprintln(os.Stderr, "reftui:", err)
			return 1
		}
		child := exec.Command(self, "--hang")
		if err := child.Start(); err != nil {
			fmt.Fprintln(os.Stderr, "reftui:", err)
			return 1
		}
		signal.Ignore(syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
		fmt.Printf("watching child=%d\r\n", child.Process.Pid)
		sleepForever()
	}
	fmt.Fprintf(os.Stderr, "reftui: unknown flag %s\nusage: reftui [--version|--list|--init]\n", args[0])
	return usageExit
}

type winsize struct {
	rows, cols, x, y uint16
}

func ioctl(request uintptr, argument unsafe.Pointer) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(0), request, uintptr(argument))
	if errno != 0 {
		return errno
	}
	return nil
}

func size() (int, int) {
	var ws winsize
	if err := ioctl(syscall.TIOCGWINSZ, unsafe.Pointer(&ws)); err != nil {
		return 0, 0
	}
	return int(ws.cols), int(ws.rows)
}

// rawMode turns off line editing, echo, signals and flow control so every key reaches the menu.
func rawMode() (func(), error) {
	var saved syscall.Termios
	if err := ioctl(syscall.TCGETS, unsafe.Pointer(&saved)); err != nil {
		return nil, err
	}
	raw := saved
	raw.Iflag &^= syscall.IGNBRK | syscall.BRKINT | syscall.PARMRK | syscall.ISTRIP |
		syscall.INLCR | syscall.IGNCR | syscall.ICRNL | syscall.IXON
	raw.Oflag &^= syscall.OPOST
	raw.Lflag &^= syscall.ECHO | syscall.ECHONL | syscall.ICANON | syscall.ISIG | syscall.IEXTEN
	raw.Cflag &^= syscall.CSIZE | syscall.PARENB
	raw.Cflag |= syscall.CS8
	raw.Cc[syscall.VMIN] = 1
	raw.Cc[syscall.VTIME] = 0
	if err := ioctl(syscall.TCSETS, unsafe.Pointer(&raw)); err != nil {
		return nil, err
	}
	return func() { _ = ioctl(syscall.TCSETS, unsafe.Pointer(&saved)) }, nil
}

type state struct {
	at     int
	status string
}

func draw(s *state) {
	cols, rows := size()
	frame := "\x1b[2J\x1b[H" + "reftui menu\r\n"
	for index, entry := range entries {
		marker := "  "
		if index == s.at {
			marker = "> "
		}
		frame += marker + entry + "\r\n"
	}
	frame += "\r\nselected: " + entries[s.at] + "\r\n"
	frame += fmt.Sprintf("size: %dx%d\r\n", cols, rows)
	if s.status != "" {
		frame += s.status + "\r\n"
	}
	os.Stdout.WriteString(frame)
}

// copyEntry writes an OSC 52 clipboard sequence for the entry.
func copyEntry(s *state, entry string) {
	os.Stdout.WriteString("\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte(entry)) + "\x07")
	s.status = "copied: " + entry
}

func menu() int {
	restore, err := rawMode()
	if err != nil {
		fmt.Fprintln(os.Stderr, "reftui: the menu needs a terminal:", err)
		return 1
	}
	os.Stdout.WriteString("\x1b[?1049h\x1b[?1h")
	quit := func(code int) int {
		os.Stdout.WriteString("\x1b[?1l\x1b[?1049l")
		restore()
		return code
	}
	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	keys := make(chan []byte)
	go func() {
		buffer := make([]byte, 64)
		for {
			count, err := os.Stdin.Read(buffer)
			if err != nil {
				close(keys)
				return
			}
			chunk := make([]byte, count)
			copy(chunk, buffer[:count])
			keys <- chunk
		}
	}()
	s := &state{}
	draw(s)
	for {
		select {
		case <-winch:
			draw(s)
		case chunk, open := <-keys:
			if !open {
				return quit(0)
			}
			for index := 0; index < len(chunk); index++ {
				key := chunk[index]
				if key == 0x1b && index+2 < len(chunk) && (chunk[index+1] == 'O' || chunk[index+1] == '[') {
					switch chunk[index+2] {
					case 'B':
						s.at = min(s.at+1, len(entries)-1)
					case 'A':
						s.at = max(s.at-1, 0)
					}
					index += 2
					continue
				}
				switch key {
				case '\r':
					copyEntry(s, entries[s.at])
				case 'q', 0x11:
					return quit(0)
				}
			}
			draw(s)
		}
	}
}
