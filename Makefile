# TestMaster local install. SELF_CONTAINED=1 stages independent production files;
# SELF_CONTAINED=0 installs a launcher bound to this checkout. Docker images are
# host prerequisites, not copied or rebuilt by this target.
#
# Usage:
#   make install                        # PREFIX=$(HOME)/.local
#   make install PREFIX=/usr/local      # needs write permission on the prefix
#   make install SELF_CONTAINED=0       # launcher points at this build tree
#   make verify
#   make uninstall

REPO_ROOT      := $(shell pwd)
PREFIX         ?= $(HOME)/.local
INSTALL_TOOL   := $(REPO_ROOT)/tools/dist/distribution/local-install.js
SELF_CONTAINED ?= 1
NODE           ?= node
PNPM           ?= pnpm

.PHONY: build install verify uninstall

build:
	"$(NODE)" -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error("TestMaster requires Node 24"); process.exit(1); }'
	cd "$(REPO_ROOT)" && "$(PNPM)" install --frozen-lockfile
	cd "$(REPO_ROOT)" && "$(PNPM)" build

install: build
	"$(NODE)" "$(INSTALL_TOOL)" install "$(PREFIX)" "$(REPO_ROOT)" "$(SELF_CONTAINED)"

verify:
	"$(NODE)" "$(INSTALL_TOOL)" verify "$(PREFIX)"

uninstall:
	"$(NODE)" "$(INSTALL_TOOL)" uninstall "$(PREFIX)"
