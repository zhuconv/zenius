#!/usr/bin/env perl
# What a release package's headers hold besides its files. tar records each
# entry's owner and group, by name and by number, and its times; gzip records
# the source file's name and time unless run with -n. Where the release is
# built, those are the builder's account and the build's hours. So
# scripts/release.sh runs this on the package it builds, and every .gz is
# checked with gzip_extras before it's published.
#
#   perl scripts/package-check.pl <file>...
#
# A .tar.gz, .tgz or .tar passes when:
# - every entry's owner and group are 0, with no names or root's;
# - all of them share one time;
# - there are no extended attributes, access or change times, or comments;
# - no link points to an absolute path;
# - each gzip member's header has no file name, comment, extra field or time.
# Prints a line for each file that holds more, or that it can't read (a zip,
# xz, bzip2 or zstd package among them: use .tar.gz). Exits 1 if there's one,
# 2 on a bad argument, else 0. Perl and its core modules only: the relay runs
# it on the Mac.
use strict; use warnings;
use IO::Uncompress::Gunzip qw($GunzipError);

# A gzip file: what its members' headers hold besides the format's own
# fields, and their data, joined. Empty list for anything that isn't gzip or
# doesn't decompress.
sub gzip_extras {
  my ($d) = @_;
  return () unless substr($d, 0, 2) eq "\x1f\x8b";
  my $z = IO::Uncompress::Gunzip->new(\$d, MultiStream => 0, Transparent => 0) or return ();
  my (@x, %had);
  my $add = sub { push @x, $_[0] unless $had{$_[0]}++ };
  my $out = "";
  while (1) {
    my $h = $z->getHeaderInfo;
    $add->("a file name in its gzip header") if defined $h->{Name} && length $h->{Name};
    $add->("a comment in its gzip header") if defined $h->{Comment};
    $add->("an extra field in its gzip header") if defined $h->{ExtraFieldRaw};
    $add->("a time in its gzip header") if $h->{Time};
    my $buf;
    my $n;
    while (($n = $z->read($buf)) > 0) { $out .= $buf }
    return () if $n < 0;
    # A member follows, or the data ends. Anything else after a member is
    # data after its end.
    my $rest = $z->trailingData;
    last unless length $rest;
    if (substr($rest, 0, 2) ne "\x1f\x8b") { $add->("data after its end"); last }
    my $next = $z->nextStream;
    return () if $next < 0;
    last unless $next;
  }
  (\@x, $out);
}

# A tar archive (ustar, GNU or pax): what its headers hold besides each
# entry's name, size, type and mode. A list; undef for anything else.
sub tar_extras {
  my ($t) = @_;
  my $len = length $t;
  return undef unless $len >= 512 && substr($t, 257, 5) eq "ustar";
  my (@x, %had, %times);
  my $add = sub { push @x, $_[0] unless $had{$_[0]}++ };
  # Octal, or base-256 (the high bit set) for a value octal can't hold.
  my $num = sub {
    my ($f) = @_;
    if (ord($f) & 0x80) {
      my $v = ord($f) & 0x3f;
      $v = $v * 256 + ord($_) for split //, substr($f, 1);
      return $v;
    }
    $f =~ tr/\0 //d;
    length $f ? oct $f : 0;
  };
  my %neutral = map { $_ => 1 } "", "root", "wheel";
  my $i = 0;
  while (1) {
    if ($i + 512 > $len) { $add->("no end"); last }
    my $h = substr($t, $i, 512);
    if ($h !~ /[^\0]/) {
      $add->("data after its end") if substr($t, $i) =~ /[^\0]/;
      last;
    }
    # uid at 108, gid, size, mtime, the checksum, the type at 156, the link,
    # magic and version at 257, uname at 265, gname at 297.
    my ($uid, $gid, $size, $mtime, $type, $link, $uname, $gname) =
      unpack "x108 a8 a8 a12 a12 x8 a1 Z100 x8 Z32 Z32", $h;
    $size = $num->($size);
    my $data = substr($t, $i + 512, $size);
    $i += 512 + (($size + 511) & ~511);
    $add->("an owner or group other than 0") if $num->($uid) || $num->($gid);
    $add->("an owner's or group's name") unless $neutral{$uname} && $neutral{$gname};
    # pax records, "<length> <key>=<value>\n": the next entry's ('x') or the
    # whole archive's ('g').
    if ($type eq "x" || $type eq "g") {
      my $p = 0;
      while ($p < length($data) && substr($data, $p) =~ /\A(\d+) ([^=\n]+)=/) {
        my ($n, $key) = ($1, $2);
        my $head = length("$n $key=");
        my $value = substr($data, $p + $head, $n - $head - 1);
        $p += $n;
        if ($key eq "uname" || $key eq "gname") { $add->("an owner's or group's name") unless $neutral{$value} }
        elsif ($key eq "uid" || $key eq "gid") { $add->("an owner or group other than 0") if $value =~ /[^0]/ }
        elsif ($key eq "mtime") { $times{int $value} = 1 }
        elsif ($key eq "atime" || $key eq "ctime") { $add->("access or change times") }
        elsif ($key eq "linkpath") { $add->("a link to an absolute path") if $value =~ m{\A/} }
        elsif ($key eq "comment") { $add->("a comment") }
        elsif ($key =~ /xattr|acl|fflags/i) { $add->("extended attributes") }
      }
      next;
    }
    # GNU's long name or link: the next entry's, under a header of its own.
    next if $type eq "L" || $type eq "K";
    $times{$num->($mtime)} = 1;
    $add->("a link to an absolute path") if ($type eq "1" || $type eq "2") && $link =~ m{\A/};
  }
  $add->("more than one time: each file's own, not one for the package") if keys %times > 1;
  \@x;
}

# A package: what its headers hold besides its files, gzip's and tar's. A
# list; undef for anything else.
sub package_extras {
  my ($d) = @_;
  if (substr($d, 0, 2) eq "\x1f\x8b") {
    my ($x, $t) = gzip_extras($d);
    return undef unless $x;
    my $y = tar_extras($t) or return undef;
    return [@$x, @$y];
  }
  tar_extras($d);
}

unless (caller) {
  if (!@ARGV || grep { /\A-/ } @ARGV) { print STDERR "usage: perl scripts/package-check.pl <file>...\n"; exit 2 }
  my $bad = 0;
  for my $f (@ARGV) {
    open my $h, "<:raw", $f or do { print STDERR "package-check: $f: $!\n"; exit 2 };
    my $d = do { local $/; <$h> } // "";
    my $x = package_extras($d);
    if (!$x) { print "$f: a package this check can't read; use .tar.gz\n"; $bad = 1 }
    elsif (@$x) { print "$f: besides its files, its headers hold " . join("; ", @$x) . "; build it without them\n"; $bad = 1 }
  }
  exit $bad;
}
1;
