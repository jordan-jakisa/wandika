# Shared by the release scripts. Source it after `cd` to the repo root.

# Released binaries must be built from source that is public on GitHub: that's what keeps them
# outside the US export rules for encryption (15 CFR 734.3(b)(3) and 742.15(b)).
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit your changes first: a release is built only from code that's on GitHub."
  exit 1
fi
git fetch -q origin
if [ -n "$(git log --oneline origin/main..HEAD)" ]; then
  echo "Push first: a release is built only from code that's on GitHub."
  exit 1
fi

# Public build: no Gmail, Google only after Google's review. Written to a file every build step
# reads (Xcode drops the environment), and removed again however the script ends.
printf 'WANDIKA_PUBLIC=1\n' > .env.release
trap 'rm -f .env.release' EXIT

# Refuses a binary that still asks for Gmail: the public build must not.
check_public() {
  if strings "$1" | grep -q "gmail.readonly"; then
    echo "This build still asks for Gmail, so it isn't the public build. Not released: $1"
    exit 1
  fi
}
