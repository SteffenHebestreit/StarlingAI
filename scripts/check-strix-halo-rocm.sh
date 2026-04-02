#!/usr/bin/env bash

set -u

status=0

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1"
  status=1
}

note() {
  printf 'INFO: %s\n' "$1"
}

kernel_release="$(uname -r 2>/dev/null || echo unknown)"
note "Kernel: $kernel_release"
kernel_major_minor="$(printf '%s' "$kernel_release" | sed -E 's/^([0-9]+\.[0-9]+).*/\1/')"
kernel_patch="$(printf '%s' "$kernel_release" | sed -E 's/^([0-9]+\.[0-9]+\.([0-9]+)).*/\2/')"
if [[ "$kernel_major_minor" =~ ^6\.[0-9]+$ ]]; then
  kernel_minor="${kernel_major_minor#6.}"
  if (( kernel_minor > 18 )) || (( kernel_minor == 18 && kernel_patch >= 4 )); then
    pass "Kernel meets the Strix Halo minimum (>= 6.18.4)"
  else
    fail "Kernel is too old for reliable Strix Halo ROCm support; AMD requires >= 6.18.4"
  fi
else
  fail "Unable to parse kernel version for Strix Halo ROCm validation"
fi

if [[ -e /dev/kfd ]]; then
  pass "/dev/kfd is present"
else
  fail "/dev/kfd is missing; ROCm compute is not exposed to WSL"
fi

if [[ -d /dev/dri ]]; then
  pass "/dev/dri is present"
else
  fail "/dev/dri is missing; DRM render nodes are not exposed to WSL"
fi

if command -v rocminfo >/dev/null 2>&1; then
  if rocminfo >/tmp/rocminfo.strix-halo.txt 2>&1; then
    if grep -qiE 'gfx1150|gfx1151|Radeon|AMD' /tmp/rocminfo.strix-halo.txt; then
      pass "rocminfo can see an AMD GPU agent"
    else
      fail "rocminfo ran but did not report a Strix Halo-compatible AMD GPU agent"
    fi
  else
    fail "rocminfo failed; ROCm user-space is not working yet"
  fi
else
  fail "rocminfo is not installed; install ROCm for WSL first"
fi

if command -v docker >/dev/null 2>&1; then
  if docker run --rm --device /dev/kfd --device /dev/dri ubuntu:22.04 bash -lc 'test -e /dev/kfd && test -d /dev/dri' >/dev/null 2>&1; then
    pass "Docker can pass AMD GPU device nodes into containers"
  else
    fail "Docker could not pass /dev/kfd and /dev/dri into a test container"
  fi
else
  fail "docker is not installed in this environment"
fi

printf '\n'
if (( status == 0 )); then
  printf 'Strix Halo ROCm preflight passed.\n'
else
  printf 'Strix Halo ROCm preflight failed. Review docs/strix-halo.md before configuring any external ROCm-backed multimodal service.\n'
fi

exit "$status"
