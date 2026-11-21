#!/usr/bin/env bash
# Build zenius's public copy: a separate repo with a fresh history, one commit
# per export, staged in a local bare repo that the user pushes to GitHub
# themselves. This repo's history is never filtered and never leaves it: the
# export is made from `git archive` of one commit.
#
#   scripts/export-public.sh [--rev <commit>] [--repo <bare repo>] [--message <text>]
#                            [--scan-only] [--test] [--keep]
#
#   --rev        the commit to export (default origin/main)
#   --repo       the local bare repo that receives the export, created on the
#                first one (default ~/git/zenius-public.git). A local path only:
#                this script never talks to another host.
#   --message    the commit's message (default "zenius, first public version",
#                then "zenius, update of <UTC date>")
#   --scan-only  build and check the tree, commit nothing
#   --test       then run scripts/test-all.sh in a fresh clone of the export
#   --keep       keep the work folder (it is printed)
#
# What goes in: INCLUDE below, minus EXCLUDE and the public-page snapshots in
# DROP_GOLDENS.
# Then the private inputs, which live outside every repo in $ZENIUS_EXPORT_DIR
# (default ~/.zenius-dev/export), readable only by their owner:
#   private-strings.txt  what must not appear in the export, its file names
#                        included: plain lines are fixed strings in any case,
#                        "re:" lines Perl regexes in any case, "cs:" lines
#                        case-sensitive ones; "#" starts a comment
#   replacements.tsv     "from<TAB>to", applied in order to every text file:
#                        fixed strings, or a Perl regex after "re:"; "\n" is a
#                        line break
#   allowed.tsv          "<path glob><TAB><text>": in matching files, that text
#                        is taken out of a line before the line is checked
#   identity             the commits' author and committer, "Name <email>"
#   images-seen.txt      optional: "<sha256>  <path>" for each image someone
#                        has looked at; any other image stops the export
# This script holds none of those strings, and its report names a hit by file,
# line and list entry, never by its text. Any hit stops the export, as does a
# home folder, a key or token, or a binary file other than a .gz (whose
# contents are checked too). Commits carry UTC dates.
set -euo pipefail
# The work folder sits in a shared /tmp on some machines, and the private
# inputs' log beside them: nothing this script writes is for other users.
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
INCLUDE=(runtime sdk skill scripts tests README.md THIRD_PARTY.md LICENSE LICENSES .gitignore
  docs/SPEC.md docs/PROTOCOL.md docs/SPI.md docs/install-daily.md docs/eval docs/PARITY.md
  docs/mcp.md docs/agent-sidebar.md)
# The user's calls (2026-11-21): tryout.md is written for the agents that run
# their own tryout.
EXCLUDE=(docs/eval/tryout.md)
# Public-page snapshots to leave out, slugs from tests/golden/pages.mjs. None
# since the user's call (2026-11-21): the five whose text has no open license
# go in too, named as such in THIRD_PARTY.md.
DROP_GOLDENS=()

REV=origin/main
REPO=$HOME/git/zenius-public.git
MESSAGE=
SCAN_ONLY=0
RUN_TESTS=0
KEEP=0
while (($#)); do
  case $1 in
    --rev) REV=${2:?--rev needs a commit}; shift 2 ;;
    --repo) REPO=${2:?--repo needs a path}; shift 2 ;;
    --message) MESSAGE=${2:?--message needs text}; shift 2 ;;
    --scan-only) SCAN_ONLY=1; shift ;;
    --test) RUN_TESTS=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "export-public: unknown argument $1" >&2; exit 2 ;;
  esac
done

die() { echo "export-public: $*" >&2; exit 1; }
DIR=${ZENIUS_EXPORT_DIR:-$HOME/.zenius-dev/export}
for f in private-strings.txt replacements.tsv allowed.tsv identity; do
  [[ -f $DIR/$f ]] || die "$DIR/$f is missing"
  mode=$(stat -c %a "$DIR/$f" 2>/dev/null || stat -f %Lp "$DIR/$f")
  [[ $mode == [4-7]00 ]] || die "$DIR/$f is readable by others (mode $mode): chmod 600 it"
done
case $(cd "$DIR" && pwd -P)/ in "$ROOT"/*) die "$DIR is inside this repo; keep it outside every repo" ;; esac
IDENTITY=$(head -n 1 "$DIR/identity")
[[ $IDENTITY =~ ^([^<]*[^<[:space:]])[[:space:]]*\<([^>]+)\>$ ]] || die "$DIR/identity isn't \"Name <email>\""
NAME=${BASH_REMATCH[1]}
EMAIL=${BASH_REMATCH[2]}

case $REPO in *://* | [!/]*:*) die "--repo must be a local path: $REPO" ;; esac
[[ $REPO == /* ]] || REPO=$PWD/$REPO
SRC_REMOTE=$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)
if [[ -d $REPO && -n $SRC_REMOTE && -d $SRC_REMOTE ]] && [[ $(cd "$REPO" && pwd -P) == $(cd "$SRC_REMOTE" && pwd -P) ]]; then
  die "--repo is this repo's own origin"
fi
SHA=$(git -C "$ROOT" rev-parse --verify "$REV^{commit}") || die "no commit $REV"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/zenius-export.XXXXXX")
if ((KEEP)); then echo "export-public: work folder $WORK"; else trap 'rm -rf "${WORK:?}"' EXIT; fi
TREE=$WORK/tree
mkdir -p "$TREE"

# 1. The tree, from one commit.
paths=()
for p in "${INCLUDE[@]}"; do
  if git -C "$ROOT" cat-file -e "$SHA:$p" 2>/dev/null; then paths+=("$p"); else echo "export-public: $p isn't in ${SHA:0:7}, left out"; fi
done
git -C "$ROOT" cat-file -e "$SHA:LICENSE" 2>/dev/null || die "${SHA:0:7} has no LICENSE"
git -C "$ROOT" archive "$SHA" -- "${paths[@]}" | tar -x -C "$TREE"
for p in "${EXCLUDE[@]}"; do rm -rf "${TREE:?}/$p"; done

# 2. The public-page snapshots left out, and their records.
command -v node >/dev/null || die "node isn't on PATH"
if ((${#DROP_GOLDENS[@]})); then
  for slug in "${DROP_GOLDENS[@]}"; do
    rm -f "$TREE/tests/golden/ego/$slug".* "$TREE/tests/golden/ego/dom/$slug.html.gz"
  done
  DROP="${DROP_GOLDENS[*]}" node -e '
  const fs = require("fs");
  const drop = new Set(process.env.DROP.split(" "));
  const [index, pages] = process.argv.slice(1);
  const data = JSON.parse(fs.readFileSync(index, "utf8"));
  data.pages = data.pages.filter((r) => !drop.has(r.slug));
  // As capture.mjs writes it: non-ASCII as \u escapes.
  const json = JSON.stringify(data, null, 2).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  fs.writeFileSync(index, json + "\n");
  const lines = fs.readFileSync(pages, "utf8").split("\n");
  const kept = lines.filter((l) => ![...drop].some((s) => l.includes(`slug: "${s}"`)));
  if (lines.length - kept.length !== drop.size) throw new Error("pages.mjs: expected one line per dropped snapshot");
  fs.writeFileSync(pages, kept.join("\n"));
' "$TREE/tests/golden/ego/index.json" "$TREE/tests/golden/pages.mjs"
fi

# 3. Replacements, then 4. the check. Perl, which macOS and Linux both have.
# (read, not $(cat <<…): bash 3.2 miscounts the regexes' parentheses in $(…).)
IFS= read -r -d "" PL <<'PERL' || true
  use strict; use warnings;
  use File::Find; use IO::Uncompress::Gunzip qw(gunzip $GunzipError);
  use Digest::SHA;
  my ($tree, $dir, $mode) = @ARGV;
  sub lines_of { my ($f) = @_; open my $h, "<:raw", $f or die "$f: $!"; my @l = <$h>; chomp @l; @l }
  my @files;
  find({ no_chdir => 1, wanted => sub { push @files, $File::Find::name if -f $_ } }, $tree);
  @files = sort @files;
  sub rel { my ($f) = @_; substr($f, length($tree) + 1) }
  sub slurp { my ($f) = @_; open my $h, "<:raw", $f or die "$f: $!"; local $/; my $t = <$h>; defined $t ? $t : "" }
  sub binary { index(substr($_[0], 0, 8192), "\0") >= 0 }
  sub unesc { my ($s) = @_; $s =~ s/\\n/\n/g; $s }

  if ($mode eq "replace") {
    my @pairs;
    my $n = 0;
    for my $line (lines_of("$dir/replacements.tsv")) {
      $n++;
      next if $line =~ /^\s*(#|$)/;
      my ($from, $to) = split /\t/, $line, 2;
      die "replacements.tsv line $n has no tab\n" unless defined $to;
      my $re = $from =~ s/^re:// ? qr/$from/ : qr/\Q@{[unesc($from)]}\E/;
      push @pairs, [$n, $re, unesc($to), 0, 0];
    }
    for my $f (@files) {
      next if $f =~ /\.gz$/;
      my $text = slurp($f);
      next if binary($text);
      my $changed = 0;
      for my $p (@pairs) {
        my $k = () = $text =~ /$p->[1]/g;
        next unless $k;
        my $to = $p->[2];
        $text =~ s/$p->[1]/$to/g;
        $p->[3] += $k; $p->[4]++; $changed = 1;
      }
      if ($changed) { open my $h, ">:raw", $f or die "$f: $!"; print $h $text; close $h }
    }
    for my $p (@pairs) {
      printf "  replacements.tsv line %d: %s\n", $p->[0], $p->[3] ? "$p->[3] in $p->[4] files" : "no match (stale?)";
    }
    exit 0;
  }

  # The check.
  my @pats;
  my $n = 0;
  for my $line (lines_of("$dir/private-strings.txt")) {
    $n++;
    next if $line =~ /^\s*(#|$)/;
    if ($line =~ s/^re://) { push @pats, [$n, qr/$line/i] }
    elsif ($line =~ s/^cs://) { push @pats, [$n, qr/$line/] }
    else { push @pats, [$n, qr/\Q$line\E/i] }
  }
  my @allow;
  for my $line (lines_of("$dir/allowed.tsv")) {
    next if $line =~ /^\s*(#|$)/;
    my ($glob, $text) = split /\t/, $line, 2;
    next unless defined $text;
    (my $re = quotemeta $glob) =~ s/\\\*/[^\/]*/g;
    push @allow, [qr/^$re$/, $text];
  }
  # Not private: what a public tree must not hold in any project.
  my @generic = (
    ["home folder", qr{(?:^|[\s"\x27(=:]|file://)/(?:Users|home)/(?!(?:u|you|me|user|USER)/)[\w.-]+/}],
    ["private key", qr/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["GitHub token", qr/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/],
    ["API key", qr/\b(?:sk-ant-(?!api03-zenius-fake-key)[\w-]{10,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,})/],
    ["AWS key", qr/\bAKIA[0-9A-Z]{16}\b/],
    ["JSON web token", qr/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, qr{^tests/golden/ego/dom/}],
  );
  my %seen;
  if (-f "$dir/images-seen.txt") { for (lines_of("$dir/images-seen.txt")) { $seen{$1} = 1 if /^([0-9a-f]{64})\b/ } }
  my $hits = 0;
  sub hit { my ($what) = @_; print "  $what\n"; $hits++ }
  for my $f (@files) {
    my $rel = rel($f);
    for my $p (@pats) { hit("$rel: file name matches private-strings.txt line $p->[0]") if $rel =~ $p->[1] }
    if ($rel =~ /\.(?:png|jpe?g|gif|webp|ico|bmp|svg|avif|tiff?)$/i) {
      my $sha = Digest::SHA->new(256)->addfile($f, "b")->hexdigest;
      hit("$rel: an image nobody has looked at yet; look at it, then add \"$sha  $rel\" to images-seen.txt") unless $seen{$sha};
    }
    my $text = slurp($f);
    if ($f =~ /\.gz$/) {
      my $out;
      gunzip(\$text => \$out) or die "$rel: $GunzipError\n";
      $text = $out;
    } elsif (binary($text)) {
      hit("$rel: binary file; look at it, and add it to the export only as a .gz or text");
      next;
    }
    my @mine = map { $_->[1] } grep { $rel =~ $_->[0] } @allow;
    my $ln = 0;
    for my $line (split /\n/, $text) {
      $ln++;
      my $l = $line;
      for my $a (@mine) { $l =~ s/\Q$a\E//g }
      for my $p (@pats) { if ($l =~ $p->[1]) { hit("$rel:$ln: private-strings.txt line $p->[0]"); last } }
      for my $g (@generic) {
        next if $g->[2] && $rel =~ $g->[2];
        hit("$rel:$ln: $g->[0]") if $line =~ $g->[1];
      }
    }
  }
  printf "  %d files checked, %d hits\n", scalar @files, $hits;
  exit($hits ? 1 : 0);
PERL
perl -e "$PL" "$TREE" "$DIR" replace

echo "export-public: checking ${SHA:0:7}'s export"
if ! perl -e "$PL" "$TREE" "$DIR" check; then
  die "the export holds what it must not (above); fix it at the source, or in $DIR"
fi
files=$(find "$TREE" -type f | wc -l | tr -d ' ')
size=$(du -sk "$TREE" | cut -f1)
echo "export-public: ${SHA:0:7}: $files files, $((size / 1024)) MB, ${#DROP_GOLDENS[@]} snapshots left out"
((SCAN_ONLY)) && { echo "export-public: --scan-only, nothing committed"; exit 0; }

# 5. One commit on the public repo's main.
export GIT_AUTHOR_NAME=$NAME GIT_AUTHOR_EMAIL=$EMAIL GIT_COMMITTER_NAME=$NAME GIT_COMMITTER_EMAIL=$EMAIL
GIT_AUTHOR_DATE="$(date -u +%s) +0000"
export GIT_AUTHOR_DATE GIT_COMMITTER_DATE=$GIT_AUTHOR_DATE
g() { git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name="$NAME" -c user.email="$EMAIL" -C "$WORK/repo" "$@"; }
if [[ ! -d $REPO ]]; then
  mkdir -p "$(dirname "$REPO")"
  git init -q --bare "$REPO"
  git -C "$REPO" symbolic-ref HEAD refs/heads/main
fi
if git -C "$REPO" rev-parse -q --verify refs/heads/main >/dev/null; then
  git clone -q "$REPO" "$WORK/repo"
  g rm -rq --cached . >/dev/null
  find "$WORK/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  : "${MESSAGE:=zenius, update of $(date -u +%Y-%m-%d)}"
else
  git init -q "$WORK/repo"
  g symbolic-ref HEAD refs/heads/main
  : "${MESSAGE:=zenius, first public version}"
fi
cp -a "$TREE"/. "$WORK/repo"/
g add -A
if g diff --cached --quiet && g rev-parse -q --verify HEAD >/dev/null; then
  echo "export-public: no change since the last export"; exit 0
fi
g commit -q -m "$MESSAGE"
g push -q "$REPO" HEAD:refs/heads/main
commit=$(g rev-parse HEAD)
printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SHA" "$commit" "$REPO" >>"$DIR/exports.log"
echo "export-public: $REPO main is ${commit:0:7}, from ${SHA:0:7}, by $NAME"

# 6. test-all in a fresh clone of the export.
if ((RUN_TESTS)); then
  # test-all names its dev instances after this folder: <suite>-export-check.
  check=$WORK/zenius-export-check
  git clone -q "$REPO" "$check"
  if [[ -d $ROOT/sdk/node_modules ]]; then cp -a "$ROOT/sdk/node_modules" "$check/sdk/"; else (cd "$check/sdk" && npm ci --no-audit --no-fund); fi
  (cd "$check" && scripts/test-all.sh) || die "test-all failed in the export's clone ($check; rerun with --keep to look)"
fi
