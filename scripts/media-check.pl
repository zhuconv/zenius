#!/usr/bin/env perl
# What an image or a movie holds besides its pixels or frames. Names, paths,
# places and times ride in metadata, and a cropped screenshot's original can
# ride after its end, so every image is checked with this before it's
# published, and the release runs it on every media file it carries
# (scripts/release.sh).
#
#   perl scripts/media-check.pl <file>...
#
# Prints a line for each file that holds more, or that it can't read, and
# exits 1 if there's one, 2 on a bad argument, else 0. Perl, which macOS and
# Linux both have, and nothing else: it runs on the Mac too.
use strict; use warnings;

# A PNG, GIF, JPEG or WebP: what it holds besides its pixels and the data to
# show them. Text, EXIF or XMP can name a person, a path or a place or hold a
# thumbnail of the uncropped original, and data after the image's end is how
# cropped screenshots leaked (aCropalypse). A list, empty when there's none;
# undef for anything else.
sub image_extras {
  my ($d) = @_;
  my $len = length $d;
  my (@x, %had);
  my $add = sub { push @x, $_[0] unless $had{$_[0]}++ };
  if (substr($d, 0, 8) eq "\x89PNG\r\n\x1a\n") {
    my %ok = map { $_ => 1 } qw(IHDR PLTE IDAT IEND tRNS cHRM gAMA iCCP sBIT sRGB cICP mDCv cLLi bKGD hIST pHYs sPLT acTL fcTL fdAT);
    my $i = 8;
    while ($i + 8 <= $len) {
      my ($n, $type) = unpack "N a4", substr($d, $i, 8);
      $add->(($type =~ /\A[aeiou]/i ? "an" : "a") . " $type chunk") unless $ok{$type};
      $i += 12 + $n;
      if ($type eq "IEND") { $add->("data after its end") if $i < $len; return \@x }
    }
    $add->("no end"); return \@x;
  }
  if ($d =~ /\AGIF8[79]a/) {
    my $table = sub { $_[0] & 0x80 ? 3 * (2 << ($_[0] & 7)) : 0 };
    # Sub-blocks from $i to their terminator: where they end, and the first.
    my $blocks = sub {
      my ($i, $first) = @_;
      while ($i < $len) { my $n = ord substr($d, $i, 1); $first //= substr($d, $i + 1, $n); $i += 1 + $n; last unless $n }
      ($i, $first // "");
    };
    my $i = 13 + $table->(ord substr($d, 10, 1));
    while ($i < $len) {
      my $b = ord substr($d, $i, 1);
      if ($b == 0x3B) { $add->("data after its end") if $i + 1 < $len; return \@x }
      if ($b == 0x21) {
        my $label = ord substr($d, $i + 1, 1);
        ($i, my $first) = $blocks->($i + 2);
        if ($label == 0xFE) { $add->("a comment") }
        elsif ($label == 0x01) { $add->("a text block") }
        elsif ($label == 0xFF) { $add->("application data ($first)") unless $first =~ /\A(?:NETSCAPE2\.0|ANIMEXTS1\.0)\z/ }
        elsif ($label != 0xF9) { $add->(sprintf "an extension block 0x%02X", $label) }
      } elsif ($b == 0x2C) {
        ($i) = $blocks->($i + 11 + $table->(ord substr($d, $i + 9, 1)));
      } else { $add->("data it can't read"); return \@x }
    }
    $add->("no end"); return \@x;
  }
  if (substr($d, 0, 2) eq "\xFF\xD8") {
    my $i = 2;
    while ($i + 4 <= $len && substr($d, $i, 1) eq "\xFF") {
      my $m = ord substr($d, $i + 1, 1);
      if ($m == 0xFF) { $i++; next }
      last if $m == 0xDA || $m == 0xD9;
      my $id = substr($d, $i + 4, 12);
      if ($m == 0xFE) { $add->("a comment") }
      elsif ($m >= 0xE0 && $m <= 0xEF) {
        my $ok = ($m == 0xE0 && $id =~ /\AJFIF\0/) || ($m == 0xE2 && $id =~ /\AICC_PROFILE\0/) || ($m == 0xEE && $id =~ /\AAdobe/);
        $add->(sprintf "an APP%d segment%s", $m - 0xE0, $m == 0xE1 ? " (EXIF or XMP)" : "") unless $ok;
      }
      $i += 2 + unpack "n", substr($d, $i + 2, 2);
    }
    # In the compressed data an 0xFF byte is followed by 0 or a restart
    # marker, so the first FF D9 after the scan's start is the end.
    my $end = index $d, "\xFF\xD9", $i;
    if ($end < 0) { $add->("no end") } elsif ($end + 2 < $len) { $add->("data after its end") }
    return \@x;
  }
  if (substr($d, 0, 4) eq "RIFF" && substr($d, 8, 4) eq "WEBP") {
    my %ok = map { $_ => 1 } ("VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP");
    my $end = 8 + unpack "V", substr($d, 4, 4);
    my $i = 12;
    while ($i + 8 <= $end && $i + 8 <= $len) {
      my ($type, $n) = unpack "a4 V", substr($d, $i, 8);
      $add->(($type =~ /\A[aeiou]/i ? "an" : "a") . " $type chunk") unless $ok{$type};
      $i += 8 + $n + ($n & 1);
    }
    $add->("data after its end") if $end < $len;
    return \@x;
  }
  return undef;
}

# An MP4 or MOV (ISO base media): what it holds besides its frames and what a
# player needs. udta and meta boxes may be there but empty, as ffmpeg writes
# them with -map_metadata -1 -fflags +bitexact; a tag, a place (loci, (c)xyz,
# Apple's keys), XMP or a vendor's uuid box, a creation or modification time,
# padding that holds data, a reference to another file, a box the top level
# doesn't have, or data after the last box each count. A list, empty when
# there's none; undef for anything else.
sub movie_extras {
  my ($d) = @_;
  my $len = length $d;
  my %top = map { $_ => 1 } qw(ftyp styp moov mdat moof mfra sidx free skip wide);
  return undef unless $len >= 8 && $top{substr($d, 4, 4)};
  my (@x, %had);
  my $add = sub { push @x, $_[0] unless $had{$_[0]}++ };
  # A box's type to show: tags under Apple's keys are numbered.
  my $name = sub {
    return "key " . unpack("N", $_[0]) if $_[0] =~ /\A\0\0/;
    (my $t = $_[0]) =~ s/\xA9/(c)/g; $t =~ s/[^\x20-\x7E]/?/g; $t;
  };
  my %walk = map { $_ => 1 } qw(moov trak mdia minf dinf stbl edts mvex moof traf mfra);
  my %timed = map { $_ => 1 } qw(mvhd tkhd mdhd);
  # The boxes from $i to $end: [type, start of contents, end], or undef when
  # one doesn't fit.
  my $boxes = sub {
    my ($i, $end) = @_;
    my @b;
    while ($i < $end) {
      return undef if $i + 8 > $end;
      my ($size, $type) = unpack "N a4", substr($d, $i, 8);
      my $head = 8;
      if ($size == 1) {
        return undef if $i + 16 > $end;
        my ($hi, $lo) = unpack "N N", substr($d, $i + 8, 8);
        ($size, $head) = ($hi * 4294967296 + $lo, 16);
      } elsif ($size == 0) {
        $size = $end - $i;
      }
      return undef if $size < $head || $i + $size > $end;
      push @b, [$type, $i + $head, $i + $size];
      $i += $size;
    }
    \@b;
  };
  my $meta;
  # MP4's meta is a full box (version and flags first); QuickTime's isn't.
  $meta = sub {
    my ($s, $e) = @_;
    my $kids = substr($d, $s, 4) eq "\0\0\0\0" ? $boxes->($s + 4, $e) : undef;
    $kids //= $boxes->($s, $e) or return $add->("a meta box it can't read");
    for my $k (@$kids) {
      my ($t, $ks, $ke) = @$k;
      if ($t eq "hdlr") { next }
      elsif ($t eq "ilst") {
        my $tags = $boxes->($ks, $ke) or return $add->("tags it can't read");
        $add->("tags (" . join(", ", map { $name->($_->[0]) } @$tags) . ")") if @$tags;
      }
      elsif ($t eq "free" || $t eq "skip") { $add->("padding that holds data") if substr($d, $ks, $ke - $ks) =~ /[^\0]/ }
      else { $add->("metadata (" . $name->($t) . ")") }
    }
  };
  my $walk;
  $walk = sub {
    my ($s, $e, $top) = @_;
    my $list = $boxes->($s, $e) or return $add->("a box it can't read, or data after its end");
    for my $b (@$list) {
      my ($t, $bs, $be) = @$b;
      if ($top && !$top{$t} && $t ne "uuid" && $t ne "meta") { $add->("a box movies don't need (" . $name->($t) . ")") }
      elsif ($t eq "uuid") { $add->("a uuid box (XMP or a vendor's data)") }
      elsif ($t eq "meta") { $meta->($bs, $be) }
      elsif ($t eq "udta") {
        my $kids = $boxes->($bs, $be) or return $add->("user data it can't read");
        for my $k (@$kids) {
          if ($k->[0] eq "meta") { $meta->($k->[1], $k->[2]) }
          else { $add->("user data (" . $name->($k->[0]) . ")") }
        }
      }
      elsif ($t eq "free" || $t eq "skip") { $add->("padding that holds data") if substr($d, $bs, $be - $bs) =~ /[^\0]/ }
      elsif ($timed{$t}) {
        my $v = ord substr($d, $bs, 1);
        my $times = substr($d, $bs + 4, $v == 1 ? 16 : 8);
        $add->("a creation or modification time") if $times =~ /[^\0]/;
      }
      elsif ($t eq "dref") {
        # Each entry's flag 1 says the data is in this file; any other entry
        # points elsewhere, by a path or a URL.
        my $entries = $boxes->($bs + 8, $be) or return $add->("a data reference it can't read");
        for my $r (@$entries) {
          my $self = $r->[2] - $r->[1] >= 4 && (unpack("N", substr($d, $r->[1], 4)) & 1);
          $add->("a reference to another file") unless $self && $r->[2] - $r->[1] == 4;
        }
      }
      elsif ($walk{$t}) { $walk->($bs, $be, 0) }
    }
  };
  $walk->(0, $len, 1);
  \@x;
}

sub media_extras { my ($d) = @_; image_extras($d) // movie_extras($d) }

unless (caller) {
  if (!@ARGV || grep { /\A-/ } @ARGV) { print STDERR "usage: perl scripts/media-check.pl <file>...\n"; exit 2 }
  my $bad = 0;
  for my $f (@ARGV) {
    open my $h, "<:raw", $f or do { print STDERR "media-check: $f: $!\n"; exit 2 };
    my $d = do { local $/; <$h> } // "";
    my $x = media_extras($d);
    if (!$x) { print "$f: a format this check can't read; use PNG, GIF, JPEG, WebP or MP4\n"; $bad = 1 }
    elsif (@$x) { print "$f: besides its pixels, it has " . join("; ", @$x) . "; save it without them\n"; $bad = 1 }
  }
  exit $bad;
}
1;
