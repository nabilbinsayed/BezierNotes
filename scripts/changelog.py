#!/usr/bin/env python3
"""Write CHANGELOG.md from conventional commits (Plan 098).

Each release section lists the commits since the previous tag, grouped by
type (feat, fix, perf, refactor, test, docs, chore). Commits after the newest
tag go under the version in VERSION, marked unreleased.

  scripts/changelog.py                 # tags v* as release boundaries
  scripts/changelog.py --since <rev>   # no tags yet: start the current
                                       # version's section after <rev>
"""
import argparse, pathlib, re, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
TYPES = [("feat", "Features"), ("fix", "Fixes"), ("perf", "Performance"), ("refactor", "Refactoring"),
         ("test", "Tests"), ("docs", "Documentation"), ("chore", "Maintenance"), ("build", "Build"), ("ci", "CI")]
SUBJECT = re.compile(r"^(?P<type>\w+)(?:\((?P<scope>[^)]*)\))?!?: (?P<text>.+)$")


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def section(title, rev_range):
    lines = [l for l in git("log", "--no-merges", "--format=%h\t%s", rev_range).splitlines() if l.strip()]
    groups = {t: [] for t, _ in TYPES}
    other = []
    for line in lines:
        h, s = line.split("\t", 1)
        m = SUBJECT.match(s)
        if m and m["type"] in groups:
            scope = f"**{m['scope']}:** " if m["scope"] else ""
            groups[m["type"]].append(f"- {scope}{m['text']} ({h})")
        else:
            other.append(f"- {s} ({h})")
    out = [f"## {title}", ""]
    for t, name in TYPES:
        if groups[t]:
            out += [f"### {name}", "", *groups[t], ""]
    if other:
        out += ["### Other", "", *other, ""]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="start of the current version's section when there are no tags")
    args = ap.parse_args()
    version = (ROOT / "VERSION").read_text().strip()
    tags = [t for t in git("tag", "--list", "v*", "--sort=-v:refname").split() if t]
    parts = ["# Changelog", "", "All notable changes, generated from commit messages by `scripts/changelog.py`.", ""]
    start = tags[0] if tags else args.since
    parts.append(section(f"{version} (unreleased)", f"{start}..HEAD" if start else "HEAD"))
    for newer, older in zip(tags, tags[1:] + [None]):
        parts.append(section(newer.lstrip("v"), f"{older}..{newer}" if older else newer))
    if not tags and args.since:
        parts.append(section("0.2.0 and earlier", args.since))
    (ROOT / "CHANGELOG.md").write_text("\n".join(parts).rstrip() + "\n")
    print("wrote CHANGELOG.md")


if __name__ == "__main__":
    main()
