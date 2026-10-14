"""
assistant/grounding.py
----------------------
Checks that every number, time and date in the assistant's answer came from the tool data it
was given - and from the right object. A small model rarely invents numbers outright; the usual
failure is copying a value from the wrong row (the TCA of CDM-00022 quoted for CDM-00018). So a
claim is checked against the records of the objects that the sentence talks about:

  * Records are the dicts in the tool results that carry an id (cdm_id, satellite_id, decision_id,
    ...). Values outside any record (thresholds, fleet totals) are global and always allowed.
  * Each line's scope is the set of ids it mentions; a line that mentions none inherits the scope
    of the closest line above it that did ("CDM-00018 ... :" followed by bullet points), at the
    same or a shallower list indent - a bullet after a nested sub-list belongs to the parent item.
  * A claim not found in scope is reported - as "belongs to <other id>" when it matches another
    record, or "not in tool data" when it matches nothing.

The check is advisory: issues are returned to the UI next to the answer, never hidden.
"""
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Set

_SUPERSCRIPT = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁻", "0123456789-")
_ISO_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?Z?)?")
_TIME = re.compile(r"(?<![\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])")
_SCI = re.compile(r"(\d+(?:\.\d+)?)\s*(?:[×x*]|\\times)\s*10\s*(?:\^|\*\*)?\s*\{?\s*([-−⁻]?[0-9⁰¹²³⁴⁵⁶⁷⁸⁹]+)\}?"
                  r"|(\d+(?:\.\d+)?[eE][-+]?\d+)")
_NUMBER = re.compile(r"(?<![\w#.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?!\d)")
# Unit conversions a correct answer may apply to a tool value: km<->m, s->min/h, fraction->percent.
_SCALES = (1.0, 1000.0, 0.001, 1 / 60.0, 1 / 3600.0, 60.0, 100.0)
_REL_TOL = 0.006
_SMALL_INT = 100  # bare integers up to this are counts, list numbers, percentages of nothing - not checked


def _is_id_key(key: str) -> bool:
    return key == "id" or key.endswith("_id") or key.endswith("_ids")


@dataclass
class _Values:
    numbers: List[float] = field(default_factory=list)
    times: Set[int] = field(default_factory=set)       # seconds of day
    dates: Set[str] = field(default_factory=set)

    def add_string(self, s: str):
        # Free text (a decision's rationale: "Drift 8.62 km ...") carries numbers an answer may quote.
        for c in _claims(s, keep_small=True):
            if c.kind == "number":
                self.numbers.append(c.value)
            elif c.kind == "time":
                self.times.add(c.value)
            else:
                self.dates.add(c.value)

    def merge(self, other: "_Values"):
        self.numbers.extend(other.numbers)
        self.times |= other.times
        self.dates |= other.dates


def _seconds_of_day(hms: str) -> int:
    parts = [int(p) for p in hms.split(":")] + [0]
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


class _Index:
    """Values in the tool results, split into global values and per-id records."""

    def __init__(self, sources: Iterable[object]):
        self.global_values = _Values()
        self.records: Dict[str, List[_Values]] = defaultdict(list)   # every value inside the id's records
        self.own: Dict[str, List[_Values]] = defaultdict(list)       # values directly in them, not in sub-records
        self.parents: Dict[str, Set[str]] = defaultdict(set)         # ids of the records enclosing the id's records
        self.primary: Dict[str, dict] = {}    # id -> first record whose own key names it (citations)
        for src in sources:
            self._walk(src, [])

    def _walk(self, node, enclosing: List[tuple]):
        """`enclosing` is the stack of (all values, own values, ids) of the records around `node`; a value
        belongs to all of them (a decision's burns are part of the decision), or to the global values
        outside any record."""
        if isinstance(node, dict):
            ids = self._ids_of(node)
            if ids:
                rec, own = _Values(), _Values()
                outer = set().union(*(e[2] for e in enclosing)) if enclosing else set()
                for i in ids:
                    self.records[i].append(rec)
                    self.own[i].append(own)
                    self.parents[i] |= outer - {i}
                key = next((k for k in ("cdm_id", "decision_id", "proposal_id", "id") if isinstance(node.get(k), str)), None)
                if key and node[key] not in self.primary:
                    self.primary[node[key]] = node
                enclosing = enclosing + [(rec, own, ids)]
            for v in node.values():
                self._walk(v, enclosing)
        elif isinstance(node, list):
            for v in node:
                self._walk(v, enclosing)
        elif isinstance(node, bool) or node is None:
            return
        else:
            sinks = [e[0] for e in enclosing] + [enclosing[-1][1]] if enclosing else [self.global_values]
            for sink in sinks:
                if isinstance(node, (int, float)):
                    sink.numbers.append(float(node))
                elif isinstance(node, str):
                    sink.add_string(node)

    @staticmethod
    def _ids_of(node: dict) -> Set[str]:
        ids = set()
        for k, v in node.items():
            if not _is_id_key(k):
                continue
            if isinstance(v, str) and v:
                ids.add(v)
            elif isinstance(v, list):
                ids.update(x for x in v if isinstance(x, str) and x)
        return ids

    def scope_values(self, ids: Set[str]) -> _Values:
        """A sentence about an id may quote its records, and the own fields of the records it is nested
        in (a debris inside a decision brings the decision's pc and fuel) - but not its siblings'."""
        out = _Values()
        out.merge(self.global_values)
        for i in ids:
            for rec in self.records.get(i, []):
                out.merge(rec)
            for p in self.parents.get(i, ()):
                for own in self.own.get(p, []):
                    out.merge(own)
        return out

    def all_values(self) -> _Values:
        return self.scope_values(set(self.records))

    def owners(self, matches) -> List[str]:
        return sorted(i for i, recs in self.records.items() if any(matches(r) for r in recs))


def _number_matches(value: float, candidates: List[float], decimals: int) -> bool:
    for c in candidates:
        for scale in _SCALES:
            x = c * scale
            if x == 0.0:
                if value == 0.0:
                    return True
                continue
            if abs(abs(value) - abs(x)) <= _REL_TOL * abs(x) or round(abs(x), decimals) == abs(value):
                return True
    return False


def _time_matches(seconds: int, has_seconds: bool, times: Set[int]) -> bool:
    if has_seconds:
        return any(abs(seconds - t) <= 1 for t in times)
    return any(seconds == t - t % 60 for t in times)


@dataclass
class _Claim:
    text: str
    kind: str          # number | time | date
    value: object
    decimals: int = 0
    has_seconds: bool = False


def _claims(line: str, keep_small: bool = False) -> List[_Claim]:
    out: List[_Claim] = []

    def blank(m):
        return " " * (m.end() - m.start())

    def iso(m):
        out.append(_Claim(m.group(1), "date", m.group(1)))
        if m.group(2):
            out.append(_Claim(m.group(2), "time", _seconds_of_day(m.group(2)), has_seconds=m.group(2).count(":") == 2))
        return blank(m)

    line = _ISO_DATE.sub(iso, line)

    def clock(m):
        out.append(_Claim(m.group(1), "time", _seconds_of_day(m.group(1)), has_seconds=m.group(1).count(":") == 2))
        return blank(m)

    line = _TIME.sub(clock, line)

    def sci(m):
        if m.group(3):
            text, value = m.group(3), float(m.group(3))
            mantissa = m.group(3).lower().split("e")[0]
        else:
            exponent = int(m.group(2).translate(_SUPERSCRIPT).replace("−", "-"))
            text, value, mantissa = m.group(0), float(m.group(1)) * 10.0 ** exponent, m.group(1)
        out.append(_Claim(text.strip(), "number", value, decimals=len(mantissa.partition(".")[2])))
        return blank(m)

    line = _SCI.sub(sci, line)
    for m in _NUMBER.finditer(line):
        text = m.group(1)
        value = float(text.replace(",", ""))
        decimals = len(text.split(".")[1]) if "." in text else 0
        if decimals == 0 and value <= _SMALL_INT and not keep_small:
            continue
        out.append(_Claim(text, "number", value, decimals=decimals))
    return out


def _supported(claim: _Claim, values: _Values) -> bool:
    if claim.kind == "date":
        return claim.value in values.dates
    if claim.kind == "time":
        return _time_matches(claim.value, claim.has_seconds, values.times)
    if 0.0 < abs(claim.value) < 1e-3:
        # Scientific notation: compare at the precision written (2.44e-21 vs 2.4402e-21).
        return any(c != 0.0 and abs(claim.value - c) <= 0.006 * abs(c) + 0.5 * 10 ** (-claim.decimals) * abs(c)
                   for c in values.numbers)
    return _number_matches(claim.value, values.numbers, claim.decimals)


def check(answer: str, sources: List[object], question: str = "") -> dict:
    """Grounding report for `answer` against the tool results in `sources`."""
    index = _Index(sources)
    known_ids = sorted(index.records, key=len, reverse=True)   # longest first: "IRS-P6 (RESOURCESAT-1)" before "IRS-P6"
    question_values = _Values()
    for c in _claims(question):
        if c.kind == "number":
            question_values.numbers.append(c.value)
        elif c.kind == "time":
            question_values.times.add(c.value)
        else:
            question_values.dates.add(c.value)

    issues, checked, mentioned = [], 0, []
    scope: Set[str] = set()
    scoped_lines: List[tuple] = []     # (indent, ids) of the lines that mentioned ids, in order
    for raw in answer.splitlines():
        line, ids = raw, set()
        for i in known_ids:
            if i.casefold() in line.casefold():
                ids.add(i)
                line = re.sub(re.escape(i), " " * len(i), line, flags=re.IGNORECASE)
        indent = len(raw.expandtabs(4)) - len(raw.expandtabs(4).lstrip())
        if ids:
            scope = ids
            scoped_lines.append((indent, ids))
            mentioned.extend(i for i in ids if i not in mentioned)
        elif raw.strip():
            scope = next((s for ind, s in reversed(scoped_lines) if ind <= indent), scope)
        allowed = index.scope_values(scope) if scope else index.all_values()
        allowed.merge(question_values)
        for claim in _claims(line):
            checked += 1
            if _supported(claim, allowed):
                continue
            owners = [o for o in index.owners(lambda r: _supported(claim, r)) if o not in scope]
            issue = {"claim": claim.text, "line": raw.strip(), "scope": sorted(scope)}
            if owners:
                issue.update(problem="belongs_to_other_object", belongs_to=owners[:5])
            else:
                issue.update(problem="not_in_tool_data")
            issues.append(issue)
    citations = {i: index.primary[i] for i in mentioned if i in index.primary}
    return {"checked": checked, "issues": issues, "citations": citations}
