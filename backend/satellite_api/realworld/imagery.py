"""
realworld/imagery.py
--------------------
Photos of real satellites from Wikimedia, keyed by NORAD catalog number:

  NORAD id -> Wikidata item (property P377, "SCN") -> its image (P18), or else the free lead image
  of its English Wikipedia article. Objects with no Wikidata item fall back to an English Wikipedia
  search on the catalog name, accepted only when the page is about a spacecraft and its title
  contains every word of the name. Members of a large family (STARLINK-1234, FLOCK 4P-1, ...) get
  one search per family instead, and its article's image as a representative photo (match="family").
  Commons supplies a thumbnail plus author and licence so the dashboard can credit each photo.

Searches can't be batched, so each lookup runs at most MAX_SEARCHES of them; objects beyond that are
left unresolved (None) and picked up by the next lookup, so a large fleet fills in over a few calls.

The Wikidata Query Service (SPARQL) is aggressively rate-limited, so lookups use the regular
Wikidata / Wikipedia / Commons APIs in batches of 50. Results - including "no photo" - are cached in
data/imagery/ so each satellite is looked up once a month at most; failed lookups are not cached and
are retried after RETRY_AFTER_S.
"""
import html
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from satellite_api.timeutils import data_dir

logger = logging.getLogger(__name__)

# Wikimedia throttles clients whose User-Agent carries no contact URL (meta.wikimedia.org/wiki/User-Agent_policy).
USER_AGENT = "CrimsonNebula-ACM/1.1 (https://github.com/projectideamaterials1-dev/NSH; satellite imagery)"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
THUMB_WIDTH = 640
CACHE_TTL_S = 30 * 24 * 3600
MISS_TTL_S = 3 * 24 * 3600        # "no photo" is re-checked sooner: Wikimedia gains images over time
RETRY_AFTER_S = 600
HTTP_TIMEOUT_S = 20
BATCH = 50                         # MediaWiki API limit for ids/titles per request
SEARCH_INTERVAL_S = 0.3            # searches can't be batched; run them serially and paced
MAX_SEARCHES = 40                  # per lookup call; the rest are resolved by later calls
FAMILY_MIN = 3                     # this many requested objects sharing a name prefix form a family

# A name-search hit must describe a spacecraft, not e.g. a band that shares the satellite's name.
_SPACECRAFT = re.compile(r"satellite|spacecraft|space ?station|spaceflight|space probe|module|cubesat|"
                         r"observatory|telescope|cargo|crewed|uncrewed|capsule|orbiter", re.I)

_GROUP = re.compile(r"satellites\b|constellation|series|program", re.I)

# Wikipedia lead images are sometimes logos or maps (the Starlink article's is its logo): never a photo.
_NOT_A_PHOTO = re.compile(r"\.svg$|logo|icon|wordmark|insignia|emblem|(?<![a-z])map(?![a-z])|diagram|chart", re.I)

# Families whose article has no usable photo, pinned to a verified real one on Commons.
FAMILY_PHOTOS = {
    "STARLINK": ("Starlink", "Starlink_Mission_(47926144123).jpg"),   # SpaceX, CC0: a stack of Starlinks before deployment
}

_last_failure = 0.0


class ImageryError(RuntimeError):
    pass


# ============================================================================
# HTTP
# ============================================================================
def _get(url: str, params: dict) -> dict:
    query = urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    req = urllib.request.Request(f"{url}?{query}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        raise ImageryError(f"{urllib.parse.urlsplit(url).netloc} returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise ImageryError(f"{urllib.parse.urlsplit(url).netloc} unreachable ({getattr(e, 'reason', e)})") from e


def _chunks(items: Sequence, n: int = BATCH):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def _title_map(query: dict) -> Dict[str, str]:
    """Requested title -> final title, following MediaWiki's normalisation and redirects."""
    out: Dict[str, str] = {}
    for step in (query.get("normalized") or []) + (query.get("redirects") or []):
        out[step["from"]] = step["to"]
    return out


def _resolve(title: str, mapping: Dict[str, str]) -> str:
    for _ in range(4):
        if title not in mapping:
            break
        title = mapping[title]
    return title


def _photo(file: Optional[str]) -> Optional[str]:
    return file if file and not _NOT_A_PHOTO.search(file) else None


def _claim_values(entity: dict, prop: str) -> List:
    return [c.get("mainsnak", {}).get("datavalue", {}).get("value") for c in entity.get("claims", {}).get(prop, [])]


# ============================================================================
# Wikimedia lookups
# ============================================================================
def _wikidata_items(norad_ids: Sequence[int]) -> Dict[int, dict]:
    """NORAD id -> {"label", "description", "image", "article"} for objects that have a Wikidata item."""
    qids: List[str] = []
    for chunk in _chunks(list(norad_ids), 40):   # keeps the search URL well under length limits
        search = "haswbstatement:" + "|".join(f"P377={n}" for n in chunk)
        res = _get(WIKIDATA_API, {"action": "query", "list": "search", "srsearch": search, "srlimit": BATCH})
        qids.extend(hit["title"] for hit in res.get("query", {}).get("search", []))

    wanted = {str(n) for n in norad_ids}
    best: Dict[int, Tuple[tuple, dict]] = {}
    for chunk in _chunks(qids):
        res = _get(WIKIDATA_API, {"action": "wbgetentities", "ids": "|".join(chunk),
                                  "props": "claims|sitelinks|labels|descriptions", "languages": "en", "sitefilter": "enwiki"})
        for qid in chunk:
            entity = res.get("entities", {}).get(qid)
            if not entity:
                continue
            images = [v for v in _claim_values(entity, "P18") if isinstance(v, str) and _photo(v)]
            item = {
                "qid": qid,
                "label": entity.get("labels", {}).get("en", {}).get("value"),
                "description": entity.get("descriptions", {}).get("en", {}).get("value"),
                "image": images[0] if images else None,
                "article": entity.get("sitelinks", {}).get("enwiki", {}).get("title"),
            }
            # Several items can carry the same NORAD id (e.g. the ISS and its Zarya module): prefer the one
            # with a photo, then the one with an article, then the better search hit.
            score = (item["image"] is not None, item["article"] is not None, -qids.index(qid))
            for scn in _claim_values(entity, "P377"):
                if isinstance(scn, str) and scn in wanted:
                    n = int(scn)
                    if n not in best or score > best[n][0]:
                        best[n] = (score, item)
    return {n: item for n, (_, item) in best.items()}


def _wikipedia_lead_images(titles: Sequence[str]) -> Dict[str, dict]:
    """Article title -> {"title", "description", "image"} using each article's free lead image."""
    out: Dict[str, dict] = {}
    for chunk in _chunks(list(dict.fromkeys(titles))):
        res = _get(WIKIPEDIA_API, {"action": "query", "titles": "|".join(chunk), "redirects": 1,
                                   "prop": "pageimages|description", "piprop": "name", "pilicense": "free"})
        query = res.get("query", {})
        mapping = _title_map(query)
        pages = {p["title"]: p for p in query.get("pages", []) if not p.get("missing")}
        for title in chunk:
            page = pages.get(_resolve(title, mapping))
            if page:
                out[title] = {"title": page["title"], "description": page.get("description"), "image": _photo(page.get("pageimage"))}
    return out


def _words(text: str) -> List[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def _wikipedia_search(name: str) -> Optional[dict]:
    """Best English Wikipedia page for a catalog name, only if it clearly is that spacecraft."""
    query_name = re.sub(r"\(.*?\)", " ", name).strip() or name   # "EOS-05 (GISAT-1A)" -> "EOS-05"
    words = _words(query_name)
    if not words or not any(len(w) >= 3 and not w.isdigit() for w in words):
        return None
    res = _get(WIKIPEDIA_API, {"action": "query", "generator": "search", "gsrsearch": query_name, "gsrlimit": 1,
                               "prop": "pageimages|description", "piprop": "name", "pilicense": "free"})
    for page in res.get("query", {}).get("pages", []):
        title_words = set(_words(page.get("title", "")))
        description = page.get("description") or ""
        if all(w in title_words for w in words) and _SPACECRAFT.search(description):
            return {"title": page["title"], "description": description, "image": _photo(page.get("pageimage"))}
    return None


def _family(name: str) -> Optional[str]:
    """Constellation family of a catalog name: its leading word ("STARLINK-31045" -> "STARLINK")."""
    m = re.match(r"\s*([A-Za-z]{3,})", name)
    return m.group(1).upper() if m else None


def _wikipedia_family(token: str) -> Optional[dict]:
    """Article (with a free photo) about a satellite family, e.g. GAOFEN -> "Gaofen"."""
    if token in FAMILY_PHOTOS:
        title, file = FAMILY_PHOTOS[token]
        return {"title": title, "description": "satellite constellation", "image": file}
    res = _get(WIKIPEDIA_API, {"action": "query", "generator": "search", "gsrsearch": f"{token} satellite", "gsrlimit": 3,
                               "prop": "pageimages|description", "piprop": "name", "pilicense": "free"})
    for page in sorted(res.get("query", {}).get("pages", []), key=lambda p: p.get("index", 0)):
        title, description = page.get("title", ""), page.get("description") or ""
        # A numbered page ("Cartosat-3") is one satellite, not the family, unless it describes a group.
        numbered = any(ch.isdigit() for ch in title) and not _GROUP.search(description)
        if (token.lower() in _words(title) and not title.lower().startswith("list of") and not numbered
                and _SPACECRAFT.search(description) and _photo(page.get("pageimage"))):
            return {"title": title, "description": description, "image": page["pageimage"]}
    return None


def _strip_html(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return re.sub(r"\s+", " ", text).strip() or None


def _commons_files(files: Sequence[str]) -> Dict[str, dict]:
    """Commons file name -> thumbnail/original URLs, description page, author and licence."""
    out: Dict[str, dict] = {}
    names = [f.replace("_", " ") for f in dict.fromkeys(files)]
    for chunk in _chunks(names):
        res = _get(COMMONS_API, {"action": "query", "titles": "|".join(f"File:{f}" for f in chunk),
                                 "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": THUMB_WIDTH,
                                 "iiextmetadatafilter": "Artist|LicenseShortName|ImageDescription"})
        query = res.get("query", {})
        mapping = _title_map(query)
        pages = {p["title"]: p for p in query.get("pages", [])}
        for name in chunk:
            page = pages.get(_resolve(f"File:{name}", mapping))
            info = (page or {}).get("imageinfo") or []
            if not info:
                continue
            meta = info[0].get("extmetadata", {})
            out[name] = {
                "image_url": info[0].get("thumburl") or info[0].get("url"),
                "full_url": info[0].get("url"),
                "page_url": info[0].get("descriptionurl"),
                "credit": _strip_html(meta.get("Artist", {}).get("value")),
                "license": _strip_html(meta.get("LicenseShortName", {}).get("value")),
                "caption": _strip_html(meta.get("ImageDescription", {}).get("value")),
            }
    return out


def _article_url(title: Optional[str]) -> Optional[str]:
    return f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}" if title else None


def _lookup(objects: Sequence[Tuple[int, str]]) -> Dict[int, dict]:
    """Uncached lookup. Every NORAD id it returns has an entry (photo=None when nothing was found); ids
    whose search failed or didn't fit the search budget are left out, so they are retried rather than
    cached as "no photo"."""
    items = _wikidata_items([n for n, _ in objects])

    # Wikidata items without their own image: use the article's lead image instead.
    need_lead = [it["article"] for it in items.values() if not it["image"] and it["article"]]
    lead = _wikipedia_lead_images(need_lead) if need_lead else {}

    found: Dict[int, dict] = {}
    family_size: Dict[str, int] = {}
    for _, name in objects:
        fam = _family(name)
        if fam:
            family_size[fam] = family_size.get(fam, 0) + 1
    families: Dict[str, Optional[dict]] = {}
    searches = 0

    def search(fn, arg):
        nonlocal searches
        if searches:
            time.sleep(SEARCH_INTERVAL_S)
        searches += 1
        return fn(arg)

    for n, name in objects:
        fam = _family(name)
        is_family = fam is not None and family_size.get(fam, 0) >= FAMILY_MIN
        it = items.get(n)
        if it:
            page = lead.get(it["article"]) if it["article"] else None
            found[n] = {"match": "norad", "title": it["label"] or (page or {}).get("title") or name,
                        "description": it["description"] or (page or {}).get("description"),
                        "article": it["article"], "file": it["image"] or (page or {}).get("image")}
            if found[n]["file"] or not is_family:
                continue
            # Known satellite without a free photo of its own: borrow its family's, if the budget allows.
            if fam not in families:
                if searches >= MAX_SEARCHES:
                    del found[n]   # retried by the next lookup
                    continue
                try:
                    families[fam] = search(_wikipedia_family, fam)
                except ImageryError as e:
                    logger.warning(f"Imagery search stopped at {name}: {e}")
                    del found[n]
                    break
            if families[fam]:
                found[n].update(match="family", family=families[fam]["title"], file=families[fam]["image"])
            continue
        if (not is_family or fam not in families) and searches >= MAX_SEARCHES:
            continue   # search budget spent: left unresolved for the next lookup
        try:
            if is_family:
                if fam not in families:
                    families[fam] = search(_wikipedia_family, fam)
                hit, match = families[fam], "family"
            else:
                hit, match = search(_wikipedia_search, name), "name"
        except ImageryError as e:
            logger.warning(f"Imagery search stopped at {name}: {e}")
            break
        found[n] = ({"match": match, "title": hit["title"], "description": hit["description"],
                     "article": hit["title"], "file": hit["image"], "family": hit["title"] if match == "family" else None}
                    if hit else {"match": None, "title": name, "description": None, "article": None, "file": None})

    files = _commons_files([f["file"] for f in found.values() if f["file"]])
    out: Dict[int, dict] = {}
    for n, f in found.items():
        photo = files.get(f["file"].replace("_", " ")) if f["file"] else None
        out[n] = {"norad_id": n, "match": f["match"], "title": f["title"], "description": f["description"],
                  "article_url": _article_url(f["article"]), "family": f.get("family"), "photo": photo}
    return out


# ============================================================================
# cache + public API
# ============================================================================
def _cache_path(norad_id: int):
    return data_dir() / "imagery" / f"{int(norad_id)}.json"


def _read_cache(norad_id: int) -> Optional[dict]:
    try:
        cached = json.loads(_cache_path(norad_id).read_text())
    except (OSError, ValueError):
        return None
    ttl = CACHE_TTL_S if (cached.get("entry") or {}).get("photo") else MISS_TTL_S
    return cached["entry"] if time.time() - cached.get("fetched_at", 0) < ttl else None


def _write_cache(norad_id: int, entry: dict) -> None:
    path = _cache_path(norad_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"fetched_at": time.time(), "entry": entry}))
        tmp.replace(path)
    except OSError as e:  # read-only filesystem: keep working without a cache
        logger.warning(f"Could not cache imagery for NORAD {norad_id}: {e}")


def lookup(objects: Iterable[Tuple[int, str]]) -> Dict[int, Optional[dict]]:
    """Photo info for (norad_id, catalog_name) pairs. Blocking - call from a worker thread.

    Each value is {"norad_id", "match", "title", "description", "article_url", "family", "photo"} where
    family names the constellation article a representative photo came from (match="family") and photo is
    {"image_url", "full_url", "page_url", "credit", "license", "caption"} or None. A value is None only
    when Wikimedia could not be reached and nothing was cached.
    """
    global _last_failure
    pairs = list(dict((int(n), name) for n, name in objects).items())
    result: Dict[int, Optional[dict]] = {}
    missing = []
    for n, name in pairs:
        cached = _read_cache(n)
        if cached is not None:
            result[n] = cached
        else:
            missing.append((n, name))
    if not missing:
        return result
    if time.time() - _last_failure < RETRY_AFTER_S:
        return {**{n: None for n, _ in missing}, **result}
    try:
        fresh = _lookup(missing)
    except ImageryError as e:
        _last_failure = time.time()
        logger.warning(f"Satellite imagery lookup failed: {e}")
        return {**{n: None for n, _ in missing}, **result}
    for n, entry in fresh.items():
        _write_cache(n, entry)
    return {**{n: None for n, _ in missing}, **result, **fresh}
