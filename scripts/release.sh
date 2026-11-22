#!/usr/bin/env bash
# Build zen(ius)'s release assets from one commit of this repo: the package
# the one-command install downloads, its SHA-256, and that installer.
#
#   scripts/release.sh [--rev <commit>] [--version <x.y.z>] [--out <dir>] [--url <base>]
#                      [--attach <file>]... [--test-build]
#
# Run it in a clone of the public export (scripts/export-public.sh stages
# it), at the commit being released: the export leaves out what stays private
# and replaces private strings, which a package built from this repo's own
# commits would still hold. So it refuses a commit with docs/MANAGER.md,
# docs/reports/ or docs/briefs/, unless --test-build says the assets are for
# tests and never published.
#
#   --rev      the commit to build (default HEAD). Only what the commit holds
#              goes in (git archive), never the working tree.
#   --version  the release's version (default sdk/package.json's at that
#              commit); its tag is v<version>
#   --out      the folder for the assets (default dist/release in this repo),
#              which must be empty or absent
#   --url      the folder the package is downloaded from once published
#              (default https://github.com/zhuconv/zenius/releases/download/v<version>)
#   --attach   a picture or a movie to publish beside the package, such as the
#              demo; repeatable. scripts/media-check.pl checks each one before
#              anything is built, and a file that holds more than its pixels or
#              frames (a tag, a place, XMP, a creation time), or that isn't PNG,
#              GIF, JPEG, WebP or MP4, stops the release. The check needs Perl.
#
# The assets, in --out:
#   zenius-<version>.tar.gz         zenius-<version>/ with runtime/, skill/,
#                                   sdk/ (the CLI, its bundle built here, no
#                                   tests), scripts/install.sh and
#                                   install-cli.sh, LICENSE, LICENSES/,
#                                   THIRD_PARTY.md, and RELEASE (the version
#                                   and the commit's short hash, which the
#                                   installers record, as git has none there),
#                                   and nothing else: any other file in the
#                                   staged tree, such as a platform's own
#                                   metadata, stops the build, by name.
#                                   Its entries name no one (uid and gid 0)
#                                   and carry the commit's time, so a commit
#                                   always builds the same bytes. The export's
#                                   scripts/package-check.pl checks them here.
#   zenius-<version>.tar.gz.sha256  its SHA-256, as sha256sum prints it
#   install.sh                      scripts/release-install.sh of that commit,
#                                   with the version, the package's URL and
#                                   its SHA-256 filled in
#   <file>                          each --attach file, under its own name
#
# Building the bundle needs this checkout's sdk/node_modules (npm ci in sdk/
# first): release.sh itself never uses the network, and asks nothing. It
# publishes nothing: the relay creates the release v<version> with gh,
# uploads every file in --out, and puts the SHA-256 line it prints in the
# release's notes.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_URL=https://github.com/zhuconv/zenius

die() { echo "release.sh: $*" >&2; exit 1; }

rev=HEAD version='' out='' url='' test_build=0
attach=()
while (($#)); do
  case $1 in
    --test-build) test_build=1; shift ;;
    --rev | --version | --out | --url | --attach)
      [[ $# -ge 2 && -n $2 ]] || die "$1 takes a value"
      case $1 in --rev) rev=$2 ;; --version) version=$2 ;; --out) out=$2 ;; --url) url=$2 ;; --attach) attach+=("$2") ;; esac
      shift 2 ;;
    -h | --help) sed -n '2,/^$/{s/^# \{0,1\}//;p;}' "$0"; exit 0 ;;
    *) echo "release.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || die "Node.js is needed to build the CLI's bundle"
[[ -d $ROOT/sdk/node_modules ]] || die "$ROOT/sdk/node_modules is missing: run npm ci in sdk/ first"
command -v perl >/dev/null || die "Perl is needed to check the package's headers"
[[ -f $ROOT/scripts/package-check.pl ]] || die "$ROOT/scripts/package-check.pl is missing: it checks the package's headers"
sha=$(git -C "$ROOT" rev-parse --verify --quiet "$rev^{commit}") || die "$rev isn't a commit here"
if [[ -z $version ]]; then
  version=$(git -C "$ROOT" show "$sha:sdk/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
fi
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "the version must look like 1.2.3 or 1.2.3-rc.1, not \"$version\""
url=${url:-$REPO_URL/releases/download/v$version}
url=${url%/}
# The installer quotes the URL in single quotes and passes it to curl.
[[ $url =~ ^(https|file)://[^\'[:space:]]+$ ]] || die "--url must be an https:// or file:// URL with no quote or space"
out=${out:-$ROOT/dist/release}
if [[ -e $out ]]; then
  [[ -d $out && -z $(ls -A "$out") ]] || die "$out must be an empty folder, or absent"
fi

for private in docs/MANAGER.md docs/reports docs/briefs; do
  if ((!test_build)) && git -C "$ROOT" cat-file -e "$sha:$private" 2>/dev/null; then
    die "$rev has $private, so it's a commit of the private repo: build the release in a clone of the public export, or pass --test-build for assets that are never published"
  fi
done
short=$(git -C "$ROOT" rev-parse --short "$sha")

name=zenius-$version
work=$(mktemp -d "${TMPDIR:-/tmp}/zenius-release.XXXXXX")
trap 'rm -rf "$work"' EXIT
tree=$work/$name
mkdir -p "$tree"

# The files --attach names, checked before anything is built. The check reads
# the copies that get published, so a file changed meanwhile can't slip in.
# (Each array is tested for length before it's expanded: macOS's bash 3.2
# calls an empty one unbound under set -u.)
attached=()
if ((${#attach[@]})); then
  command -v perl >/dev/null || die "Perl is needed to check the files --attach names"
  [[ -f $ROOT/scripts/media-check.pl ]] || die "$ROOT/scripts/media-check.pl is missing: it checks the files --attach names"
  mkdir "$work/attach"
  for file in "${attach[@]}"; do
    base=${file##*/}
    [[ -f $file ]] || die "--attach $file: no such file"
    # A name GitHub serves unchanged, which can't be read as an option.
    [[ $base =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "--attach $file: an asset's name takes only letters, digits, dots, dashes and underscores"
    if [[ $base == "$name.tar.gz" || $base == "$name.tar.gz.sha256" || $base == install.sh || -e $work/attach/$base ]]; then
      die "--attach $file: the release already has an asset named $base"
    fi
    cp "$file" "$work/attach/$base"
    attached+=("$base")
  done
  if ! found=$(cd "$work/attach" && perl "$ROOT/scripts/media-check.pl" "${attached[@]}" 2>&1); then
    echo "$found" >&2
    die "an --attach file must hold only its pixels or frames, as PNG, GIF, JPEG, WebP or MP4: save it without what the check found (above), and run this again"
  fi
fi

# What the release needs to install and run: the installers, the runtime,
# the CLI (with its sources, against which install-cli.sh checks that the
# bundle is current), the skill, and the license files.
packaged=(runtime sdk skill scripts/install.sh scripts/install-cli.sh LICENSE LICENSES THIRD_PARTY.md)
git -C "$ROOT" archive --format=tar "$sha" "${packaged[@]}" | tar -x -C "$tree"
rm -rf "$tree/sdk/test" "$tree/sdk/scripts"

ln -s "$ROOT/sdk/node_modules" "$tree/sdk/node_modules"
if ! log=$(cd "$tree/sdk" && node build.mjs 2>&1); then
  echo "$log" >&2
  die "building the CLI's bundle failed"
fi
rm -rf "$tree/sdk/node_modules"
[[ -f $tree/sdk/dist/zenius.mjs && -f $tree/sdk/dist/guide.md ]] || die "the build made no sdk/dist/zenius.mjs and guide.md"
printf 'version=%s\ncommit=%s\n' "$version" "$short" >"$tree/RELEASE"

# The package holds its list and nothing else: git's files for the packaged
# paths (but sdk/test and sdk/scripts), the build's two outputs, RELEASE, and
# the folders above them. Any other file in the staged tree, such as a
# platform's own metadata, stops the build by name, so every machine packs
# the same entries.
{
  git -C "$ROOT" -c core.quotePath=false ls-tree -r --name-only "$sha" -- "${packaged[@]}"
  printf '%s\n' sdk/dist/zenius.mjs sdk/dist/guide.md RELEASE
} | awk -v top="$name" '/^sdk\/(test|scripts)\// { next }
  { print top "/" $0; n = split($0, part, "/"); path = top; print path
    for (i = 1; i < n; i++) { path = path "/" part[i]; print path } }' | LC_ALL=C sort -u >"$work/list"
(cd "$work" && find "$name" -print) | LC_ALL=C sort >"$work/staged"
extra=$(LC_ALL=C comm -13 "$work/list" "$work/staged")
missing=$(LC_ALL=C comm -23 "$work/list" "$work/staged")
if [[ -n $extra ]]; then
  echo "release.sh: the staged package holds files that aren't in its list (git's files, the build's two outputs and RELEASE):" >&2
  sed 's/^/  /' <<<"$extra" >&2
fi
if [[ -n $missing ]]; then
  echo "release.sh: the staged package lacks files in its list:" >&2
  sed 's/^/  /' <<<"$missing" >&2
fi
[[ -z $extra && -z $missing ]] || die "the staged package doesn't match its list (above), so no assets were made"

# The package names no one, and one commit always makes the same bytes. A
# plain tar would record the builder's user and group, the build's times, and
# modes from the umask (0600 under export-public.sh's). So every entry gets
# uid and gid 0 with no names, the commit's time, and mode 755 (folders and
# executables) or 644, in byte order, as ustar: no pax headers, so no other
# times. gzip -n stores no name or time. bin/zenius and install-cli.sh take a
# bundle as old as its sources as current.
when=$(git -C "$ROOT" show -s --format=%ct "$sha")
stamp=$(date -u -d "@$when" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$when" +%Y-%m-%dT%H:%M:%SZ)
find "$tree" -type d -exec chmod 755 {} +
find "$tree" -type f -perm -100 -exec chmod 755 {} +
find "$tree" -type f ! -perm -100 -exec chmod 644 {} +
find "$tree" -exec touch -h -d "$stamp" {} +
if [[ $(tar --version 2>/dev/null) == *"GNU tar"* ]]; then
  owners=(--owner=0 --group=0 --numeric-owner)
else # bsdtar, as on the Mac
  owners=(--uid 0 --gid 0 --uname '' --gname '')
fi

mkdir -p "$out"
out=$(cd "$out" && pwd)
# macOS's tar would add its own metadata files without COPYFILE_DISABLE.
(cd "$work" && tr '\n' '\0' <"$work/list" |
  COPYFILE_DISABLE=1 tar -c -f - --format=ustar "${owners[@]}" --no-recursion --null -T -) | gzip -n -9 >"$out/$name.tar.gz"
# The export's own check of what the headers hold, so that no package leaves
# here naming its builder, whichever tar made it.
if ! found=$(perl "$ROOT/scripts/package-check.pl" "$out/$name.tar.gz" 2>&1); then
  echo "$found" >&2
  rm -f "$out/$name.tar.gz"
  die "the package's headers hold more than its files (above), so it's removed, and --out holds no assets"
fi
if command -v sha256sum >/dev/null; then
  hash=$(sha256sum "$out/$name.tar.gz" | cut -d' ' -f1)
else
  hash=$(shasum -a 256 "$out/$name.tar.gz" | cut -d' ' -f1)
fi
[[ $hash =~ ^[0-9a-f]{64}$ ]] || die "couldn't compute the package's SHA-256"
printf '%s  %s\n' "$hash" "$name.tar.gz" >"$out/$name.tar.gz.sha256"

git -C "$ROOT" show "$sha:scripts/release-install.sh" |
  sed -e "s|@VERSION@|$version|g" -e "s|@URL@|$url/$name.tar.gz|g" -e "s|@SHA256@|$hash|g" >"$out/install.sh"
if grep -q '@[A-Z0-9]*@' "$out/install.sh"; then die "install.sh still has a placeholder"; fi
chmod 755 "$out/install.sh"
if ((${#attached[@]})); then
  for base in "${attached[@]}"; do mv "$work/attach/$base" "$out/$base"; done
fi

size=$(wc -c <"$out/$name.tar.gz" | tr -d ' ')
echo "release.sh: zen(ius) $version from $short"
if ((test_build)); then echo "  a test build: never publish these assets"; fi
echo "  $out/$name.tar.gz ($((size / 1024)) KiB)"
echo "  $out/$name.tar.gz.sha256"
echo "  $out/install.sh"
if ((${#attached[@]})); then
  for base in "${attached[@]}"; do echo "  $out/$base ($(($(wc -c <"$out/$base") / 1024)) KiB)"; done
fi
echo "SHA-256 for the release notes: $hash  $name.tar.gz"
