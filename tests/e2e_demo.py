"""End-to-end test of the app in demo mode (headless Chrome).

Run:  python3 tests/e2e_demo.py      (starts its own local web server)
Needs: python playwright + a Chrome/Chromium binary (CHROME env var or /usr/bin/google-chrome).
"""
import json, os, re, subprocess, sys, time, threading, http.server, socketserver
from datetime import date, timedelta
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765
BASE = f"http://localhost:{PORT}/"
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingTCPServer):       # threaded: two browser contexts can load at once
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, *a):
        pass                                          # a browser closing a connection is not a test failure


httpd = Server(("", PORT), Quiet)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

today = date.today()
sat1 = today + timedelta(days=(5 - today.weekday()) % 7)   # next Saturday (or today)
sat2 = sat1 + timedelta(days=7)
D1, D2 = sat1.isoformat(), sat2.isoformat()

# ---- fake Play Cricket service (same JSON shape as the live one) -------------
def match(mid, rnd, mtype, days, home, away, venue):
    return {"id": mid, "status": "SCHEDULED", "matchType": mtype, "round": {"id": "r", "name": rnd, "shortName": "R"},
            "matchSchedule": [{"matchDay": i + 1, "startDateTime": f"{d}T13:30:00.0000000+11:00"} for i, d in enumerate(days)],
            "venue": {"name": venue, "line1": "1 Test St", "suburb": "PARRAMATTA", "playingSurface": {"name": venue, "latitude": -33.8, "longitude": 151.0}},
            "teams": [{"id": mid + "h", "displayName": home, "isHome": True, "owningOrganisation": {"name": home + " Cricket Club"}},
                      {"id": mid + "a", "displayName": away, "isHome": False, "owningOrganisation": {"name": away + " Cricket Club"}}]}

API = {
    "g-a": [match("m1", "Round 2", "Two Day", [D1, D2], "Kings Langley", "Vone", "Pearce Reserve"),
            match("m2", "Round 9", "Two Day", [(sat1 + timedelta(days=56)).isoformat()], "Late", "Game", "Far Park"),
            {"id": "bye", "matchType": "BYE", "matchSchedule": [], "teams": []}],
    "g-b": [match("m3", "Round 2", "Two Day", [D1, D2], "Wenty Leagues", "Parramatta", "Darling Street")],
    "g-w": [match("m4", "Round 4", "T20", [D2], "Perry", "Gold", "School Oval")],
    "g-j": [match("m5", "Round 2", "One Day", [D1], "Juniors Red", "Juniors Blue", "Kids Park")],
    "g-t": [match("m6", "Round 1", "T20", [D2], "Twenty A", "Twenty B", "Short Oval")],
    # juniors mix game lengths: day 2 of the U14 two-day round is a one-day round for U13
    "g-u14": [match("m7", "Round 3", "Two Day", [(sat1 + timedelta(days=14)).isoformat(), (sat1 + timedelta(days=21)).isoformat()], "Fourteen A", "Fourteen B", "Teen Oval")],
    "g-u13": [match("m8", "Round 4", "One Day", [(sat1 + timedelta(days=21)).isoformat()], "Thirteen A", "Thirteen B", "Teen Oval")],
}
API_DOWN = True   # the first "Load sample data" runs with Play Cricket unreachable -> made-up fixtures


def fulfill_api(route):
    if API_DOWN:
        route.abort()
        return
    url = route.request.url
    cors = {"access-control-allow-origin": "*"}
    if "/seasons" in url:
        body = {"seasons": [{"id": "s1", "name": "Summer 2026/27", "isCurrentSeason": True, "startDate": "2026-07-01"}]}
    elif "competition-seasons" in url:
        body = {"competitionSeasons": [
            {"competition": {"id": "c-sen", "name": "PDCA Senior Competition"}, "grades": [{"id": "g-a", "name": "Senior A Grade"}, {"id": "g-b", "name": "Senior B01"}, {"id": "g-w", "name": "Senior Women"}]},
            {"competition": {"id": "c-jun", "name": "PDCA Junior Competition"}, "grades": [{"id": "g-j", "name": "U10 Blue North"}, {"id": "g-u14", "name": "U14 Gold"}, {"id": "g-u13", "name": "U13 Gold"}]},
            {"competition": {"id": "c-t20", "name": "PDCA T20 Competition"}, "grades": [{"id": "g-t", "name": "T20 Mens"}]}]}
    else:
        m = re.search(r"/scores/grades/([^/]+)/matches", url)
        body = {"matches": API.get(m.group(1), [])} if m else {}
    route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps(body))


def fmt_day_check():
    d = sat1 + timedelta(days=56)
    return d.strftime("%a, ") + str(d.day) + d.strftime(" %b")


errors = []
passed = 0


def check(cond, msg):
    global passed
    if not cond:
        print("FAIL:", msg)
        errors.append(msg)
    else:
        passed += 1
        print("  ok:", msg)


def sign_in(page, email):
    page.goto(BASE + "#/")
    page.wait_for_selector("#login-email, .nav")
    if page.locator("#login-email").count():
        page.fill("#login-email", email)
        page.click("button:has-text('Sign in')")
    expect(page.locator(".who")).to_be_visible()


def sign_out(page):
    page.click("button:has-text('Sign out')")
    page.wait_for_selector("#login-email")


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "ERR_" not in m.text and "Failed to fetch" not in m.text else None)
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("dialog", lambda d: d.accept())
    page.route("https://grassrootsapiproxy.cricket.com.au/**", fulfill_api)

    print("Admin: Allocate page, one tile per competition")
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    check(page.locator("text=Season dates").count() == 0 and page.locator("text=New round").count() == 0 and page.locator("text=Re-sync").count() == 0, "no Season dates card, Re-sync or New round button")
    page.wait_for_selector(".notice.warn:has-text('Could not load the fixtures')")
    check(True, "with Play Cricket unreachable the officer gets a clear message and a retry link")
    page.click("button:has-text('Load sample data')")
    page.wait_for_selector(".tile-round")
    tile = lambda name, n=0: page.locator(f".comp-tile:has(h2:has-text('{name}'))").nth(n)
    check(page.locator(".comp-tile h2").all_inner_texts() == ["Senior", "Junior", "Junior", "T20"], "Senior, T20 and Junior, plus a second Junior tile (one-day games on the second Saturday of a two-day round)")
    check("One Day" in tile("Junior", 1).inner_text() and "Two Day" not in tile("Junior", 1).inner_text() and re.search(r"28 NOV", tile("Junior", 1).inner_text().upper()) and "21/28" not in tile("Junior", 1).inner_text(), "the extra Junior tile has its own date and only One Day games")
    check(page.locator("button:has-text('Load more')").count() == 1, "Load more is offered: the sample season has later rounds")
    check(page.locator("hr.set-break").count() == 0, "the first set needs no divider")
    bx = page.locator(".load-more button").bounding_box()
    check(abs((bx["x"] + bx["width"] / 2) - 640) < 40, "Load more sits in the middle of the page")
    page.click("button:has-text('Load more')")
    check(page.locator("hr.set-break").count() == 1 and page.locator(".comp-tile").count() > 4, "Load more adds the next set below a divider")
    page.screenshot(path="/tmp/sets.png")
    page.reload()
    page.wait_for_selector(".tile-round")
    sen_t = tile("Senior").inner_text()
    check(re.search(r"\d+/\d+ NOV", sen_t.upper()) and "ROUND" not in sen_t.upper(), "tile headline is the dates, not the round name")
    check("5 grades" in sen_t and "0/26 slots filled" in sen_t, "Senior tile: 5 grades, 0/26 slots filled")
    check("Two Day" in sen_t and "Mens" not in sen_t and "Women" not in sen_t, "Senior tile shows Play Cricket's own match type: Two Day (no made-up grade groups)")
    check("T20" in tile("T20").inner_text().replace("T20\n", "", 1), "T20 tile shows the match type T20")
    check("One Day & Two Day" in tile("Junior").inner_text(), "Junior tile shows its match types before any grade is picked: One Day & Two Day")
    check("2 grades" in tile("T20").inner_text() and "0/4 slots filled" in tile("T20").inner_text(), "T20 tile: 2 grades, 0/4 slots filled")
    check("0 grades" in tile("Junior").inner_text() and "0/0 slots filled" in tile("Junior").inner_text() and "Not published" in tile("Junior").inner_text(), "Junior tile with nothing picked: 0 grades, 0/0 slots filled, Not published")
    check(page.locator("a.tile-body").count() == 4, "each tile opens its own round")
    check(page.locator(".comp-tile button:has-text('Select grades')").count() == 0, "no Select grades button on the tiles")

    print("Admin: Select grades")
    dlg = page.locator("dialog.modal")

    def open_grades(name, n=0):                      # the popup now lives on the board, not the tile
        tile(name, n).locator("a.tile-body").click()
        page.wait_for_selector("button:has-text('Select grades')")
        page.click("button:has-text('Select grades')")
        dlg.wait_for(state="visible")

    def back_to_rounds():
        page.click("a.tab:has-text('All rounds')")
        page.wait_for_selector(".comp-tile")

    open_grades("Junior")
    check(dlg.locator(".grade-row").count() == 2, "popup lists the Junior grades that play this round (U12 Gold, U14 Blue)")
    check("2 games" in dlg.locator(".grade-row:has-text('U12')").inner_text() and "1 game" in dlg.locator(".grade-row:has-text('U14')").inner_text(), "each grade shows its game count")
    check("One Day" in dlg.locator(".grade-row:has-text('U12')").inner_text() and "Two Day" in dlg.locator(".grade-row:has-text('U14')").inner_text() and "Round" not in dlg.locator(".grade-list").inner_text(), "each grade shows its Play Cricket match type, not the round")
    check("No grades selected" in dlg.inner_text(), "nothing ticked at first")
    dlg.locator(".grade-row:has-text('U12') input[type=checkbox]").check()
    check("1 grade" in dlg.inner_text() and "2 umpire slots" in dlg.inner_text(), "ticking U12 Gold (2 games) = 2 slots")
    dlg.locator(".grade-row:has-text('U14') input[type=checkbox]").check()
    check("2 grades" in dlg.inner_text() and "4 umpire slots" in dlg.inner_text(), "U14 Blue is one two-day game: 2 more slots (4 total)")
    check(dlg.locator("select").count() == 0 and "umpire" not in dlg.locator(".grade-row").first.inner_text(), "no 1 / 2 umpires choice in the popup (that is set per game on the board)")
    dlg.locator("button:has-text('Done')").click()
    dlg.wait_for(state="detached")
    back_to_rounds()
    check("2 grades" in tile("Junior").inner_text() and "0/4 slots filled" in tile("Junior").inner_text(), "Junior tile updates to 2 grades, 0/4 slots filled")
    check("One Day & Two Day" in tile("Junior").inner_text(), "picking U12 (One Day) and U14 (Two Day) keeps One Day & Two Day")
    open_grades("Junior")
    check(dlg.locator(".grade-row:has-text('U14') input[type=checkbox]").is_checked(), "ticked grades stay ticked when the popup is reopened")
    check([t.split()[0] for t in dlg.locator(".grade-row .chip").all_inner_texts()] == ["U14", "U12"], "Junior grades are listed oldest age group first (U14 before U12)")
    dlg.locator("button:has-text('None')").click()
    check("No grades selected" in dlg.inner_text(), "the None link clears every grade")
    dlg.locator(".grade-row:has-text('U12') input[type=checkbox]").check()
    dlg.locator("button:has-text('Done')").click()
    dlg.wait_for(state="detached")
    back_to_rounds()
    check("1 grade" in tile("Junior").inner_text() and "0/2 slots filled" in tile("Junior").inner_text(), "Junior tile settles at 1 grade, 0/2 slots filled")
    check("One Day" in tile("Junior").inner_text() and "Two Day" not in tile("Junior").inner_text(), "with only U12 picked the Junior tile says One Day")

    print("Admin: a board lists only that competition's picked grades")
    tile("Junior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    check(page.locator("h1").first.inner_text() == "Junior \u00b7 Round 2", "board is headed 'Junior \u00b7 Round 2'")
    check(page.locator("table.board tbody tr").count() == 2 and page.locator("td:has-text('Senior')").count() == 0, "only the two U12 Gold games: no Senior games, no unpicked grades")
    check(page.locator("text=0 of 2 slots filled").count() == 1, "summary matches the tile")
    d1_label = sat1.strftime("%a, ") + str(sat1.day) + sat1.strftime(" %b")
    def pick(idx, name):
        sel = page.locator("select.slot").nth(idx)
        val = sel.evaluate("(s, n) => { const o = [...s.options].find(o => o.text.startsWith(n)); return o ? o.value : null }", name)
        sel.select_option(value=val)
        page.wait_for_timeout(250)
    def slot_for(pattern):
        return page.locator("select.slot").evaluate_all(
            "(els, [pat, day]) => els.findIndex(e => new RegExp(pat).test(e.getAttribute('aria-label')) && e.getAttribute('aria-label').endsWith(day))", [pattern, d1_label])
    i_jun = slot_for(r"^Umpire 1, U12 Gold Kings Langley")
    check(i_jun >= 0, "found the Junior slot")
    pick(i_jun, "Demo Umpire 2")
    page.click("a.tab:has-text('All rounds')")
    page.wait_for_selector(".comp-tile")
    check("1/2 slots filled" in tile("Junior").inner_text(), "Junior tile now shows 1/2 slots filled")

    print("Admin: the same umpire on a Senior and a Junior game on one day")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    check(page.locator("h1").first.inner_text() == "Senior \u00b7 Round 2", "board is headed 'Senior \u00b7 Round 2'")
    check(page.locator("table.board tbody tr").count() == 13 and page.locator("td:has-text('U12')").count() == 0, "Senior board lists the 13 Senior games and no Junior games")
    check(page.locator("section.card h2").count() == 1, "one section: the Senior round")
    check(page.locator("text=0 of 26 slots filled").count() == 1, "26 slot-days: 13 two-day games")
    i_sen = slot_for(r"^Umpire 1, A GLCC Senior Maroon")
    pick(i_sen, "Demo Umpire 2")
    check(page.locator(".warn-icon").count() == 0, "Umpire 2 is on a Junior game and a Senior game the same day: no warning")
    check(page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.value") == "", "Umpire 2 is not free on Day 2, so Day 2 is left empty")
    page.locator("select.slot").nth(i_sen).select_option(value="")
    page.wait_for_timeout(250)

    print("Admin: manual allocation + warnings")
    first = page.locator("select.slot").first
    avoid_val = first.evaluate("s => { const o = s.querySelector('optgroup[label^=\"Unavailable\"] option'); return o ? o.value : null }")
    check(avoid_val is not None, "slot dropdown offers an 'Unavailable or already busy' group")
    first.select_option(value=avoid_val)
    page.wait_for_timeout(250)
    check(page.locator(".warn-icon").count() >= 1, "choosing an unavailable umpire shows a warning icon")
    check(page.locator("text=1 warning").count() >= 1, "summary counts the warning")
    page.locator("select.slot").first.select_option(value="")
    page.wait_for_timeout(250)
    check(page.locator(".warn-icon").count() == 0, "clearing the slot clears the warning")

    print("Admin: two-day game lists umpires free on both days first")
    sel0 = page.locator("select.slot").nth(i_sen)
    groups = sel0.evaluate("s => [...s.querySelectorAll('optgroup')].map(g => g.label)")
    check(groups[0] == "Available both days" and "Available this day only" in groups, f"Day 1 dropdown groups: {groups}")
    both = sel0.evaluate("s => [...s.querySelector('optgroup').querySelectorAll('option')].map(o => o.text)")
    check(page.locator("select.slot").nth(i_sen + 1).get_attribute("aria-label").endswith(sat2.strftime("%a, ") + str(sat2.day) + sat2.strftime(" %b")), "the next dropdown is the same game on Day 2")
    first_name = both[0].split(" \u00b7")[0]
    pick(i_sen, first_name)
    d2_val = page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.options[s.selectedIndex].text")
    check(d2_val.startswith(first_name), f"choosing {first_name} for Day 1 also fills Day 2 ({d2_val})")
    check(page.locator(".warn-icon").count() == 0, "...with no warnings")
    page.locator("select.slot").nth(i_sen + 1).select_option(value="")
    page.wait_for_timeout(250)
    check(page.locator("select.slot").nth(i_sen + 1).evaluate("s => s.value") == "", "Day 2 can still be changed separately")
    page.locator("select.slot").nth(i_sen).select_option(value="")
    page.wait_for_timeout(250)

    print("Admin: suggest allocations")
    page.click("button:has-text('Suggest allocations')")
    m = re.search(r"(\d+) of 26 slots filled", page.locator(".summary").inner_text())
    filled = int(m.group(1))
    check(filled > 5, f"auto-suggest filled {filled} of 26 slots")
    check(page.locator(".warn-icon").count() == 0, "auto-suggested allocations have no warnings")
    labels = page.eval_on_selector_all("select.slot", "els => els.map(e => [e.getAttribute('aria-label'), e.value])")
    by_day = {}
    for lab, val in labels:
        if val:
            by_day.setdefault(lab.split(", ")[-1], []).append(val)
    check(all(len(v) == len(set(v)) for v in by_day.values()), "no umpire is allocated to two Senior games on the same day")

    print("Admin: umpires per game")
    page.wait_for_timeout(300)
    page.locator("select.n-slots").first.select_option("2")
    page.wait_for_timeout(300)
    m = re.search(r"of (\d+) slots", page.locator(".summary").inner_text())
    check(int(m.group(1)) == 26 + 2, f"asking for 2 umpires on one two-day game adds 2 slots (now {m.group(1)})")
    page.locator("select.n-slots").first.select_option("1")
    page.wait_for_timeout(300)

    print("Admin: availability tab, report tab, publish")
    page.click("a.tab:has-text('Availability')")
    page.wait_for_selector("table.board")
    check(page.locator("td.av.ok").count() > 0 and page.locator("td.av.no").count() > 0, "availability grid shows yes and no cells")
    check(page.locator("th", has_text=re.compile("junior", re.I)).count() == 0, "this competition's grid has no Junior columns")
    page.click("a.tab:has-text('Report')")
    page.wait_for_selector(".report-table")
    check(page.locator("text=Copy report as text").count() == 0 and page.locator("text=Print").count() == 0, "no 'Copy report as text' and nothing about printing")
    with page.expect_download() as dl:
        page.click("button:has-text('Download PDF')")
    pdf = dl.value
    pdf.save_as("/tmp/report-download.pdf")
    check(pdf.suggested_filename.endswith(".pdf"), f"Download PDF saves a file ({pdf.suggested_filename})")
    check(open("/tmp/report-download.pdf", "rb").read(5) == b"%PDF-", "the downloaded file is a real PDF")
    check(page.locator(".report-table tbody tr").count() == 13, "report lists the 13 Senior games")
    check(page.locator(".report-table th:has-text('UMPIRES')").count() == 1, "one report table for the Senior round")
    page.click("a.tab:has-text('Assign')")
    page.wait_for_selector("table.board")
    check(page.locator(".publish button").first.inner_text() == "Publish" and page.locator(".publish input[type=checkbox]").count() == 0,
          "publishing is one button, not a tick box")
    page.click(".publish button:has-text('Publish')")
    page.wait_for_selector(".publish button:disabled")
    check(page.locator(".publish button").first.inner_text().startswith("Published ") and page.locator("button:has-text('Unpublish')").count() == 1,
          "once published the button says when, and Unpublish appears")
    check(page.locator(".publish button").first.is_disabled(), "the Publish button is spent until something changes")

    sel0 = page.locator("select.slot").first
    was = sel0.input_value()
    free = sel0.evaluate("s => [...s.options].map(o => o.value).filter(Boolean)")
    sel0.select_option(value=("" if was else free[0]))
    page.wait_for_timeout(350)
    check(page.locator(".publish button").first.inner_text() == "Re-publish", "changing an allocation after publishing asks for a re-publish")
    page.click("a.tab:has-text('All rounds')")
    page.wait_for_selector(".comp-tile")
    check("Changes to publish" in tile("Senior").inner_text(), "the tile says so too")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    page.locator("select.slot").first.select_option(value=was)
    page.wait_for_timeout(350)
    page.click(".publish button:has-text('Re-publish')")
    page.wait_for_selector(".publish button:disabled")
    check(page.locator(".publish button").first.inner_text().startswith("Published "), "re-publishing clears the warning")
    page.click("a.tab:has-text('All rounds')")
    page.wait_for_selector(".comp-tile")
    check("Published" in tile("Senior").inner_text() and "Changes to publish" not in tile("Senior").inner_text(), "and the tile is back to Published")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")

    print("Umpire: one page - appointments + season availability")
    sign_out(page)
    sign_in(page, "umpire1@demo.test")
    page.wait_for_selector(".tile")
    check(page.locator(".nav-link").count() == 0, "umpire header has no navigation links")
    check(page.locator("h2:has-text('My appointments')").count() == 1, "published appointments show on the same page")
    check(page.locator("li.appt a[href*='maps']").count() >= 1, "appointment links to a map")
    titles = page.locator(".comp-title").all_inner_texts()
    check(titles == ["Senior", "T20", "Junior"], f"one section per competition: {titles}")
    sen = page.locator(".comp-section:has(h2:has-text('Senior'))")
    jun = page.locator(".comp-section:has(h2:has-text('Junior'))")
    # Senior and T20 games are all the same length -> by round with Day 1 / Day 2; Junior mixes lengths -> date list
    check(sen.locator(".tile").count() == 6 and sen.locator(".drow").count() == 12, "Senior (all two-day): six rounds, 12 rows")
    check(sen.locator(".tile h3").first.inner_text() == "Round 2", "Senior tile is titled 'Round 2'")
    first_label = sen.locator(".dlabel").first.inner_text()
    check(first_label.startswith("Day 1 \u00b7 "), f"Senior row label reads '{first_label}' (date shown once)")
    date_part = first_label.split("\u00b7 ")[1]
    check(sen.locator(".tile").first.inner_text().count(date_part) == 1, f"'{date_part}' appears once in the tile")
    tt = [t for t in page.locator(".comp-section:has(h2:has-text('T20')) .tile h3").all_inner_texts()]
    check(tt and tt[0] == "Round 1", f"T20 (all one-day) is also by round: {tt[:2]}")
    jtxt = jun.inner_text()
    check("Round" not in jtxt and "Day 1" not in jtxt and "Day 2" not in jtxt, "Junior (mixed lengths) has no round or Day 1 / Day 2 text")
    jlabels = jun.locator(".dlabel").all_inner_texts()
    check(re.fullmatch(r"[A-Z][a-z]+ 20\d\d", jun.locator(".tile h3").first.inner_text()) is not None and all(re.fullmatch(r"[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}", t) for t in jlabels), f"Junior is a date list under month headings: {jlabels[:2]}")
    check(page.locator(".dlabel", has_text=date_part).count() >= 2, "the same date is listed under more than one competition (overlapping dates)")
    check(page.locator("button.opt").count() == 2 * page.locator(".drow").count(), "only two options per day (Available / Not available)")
    check(page.locator("text=Maybe").count() == 0 and page.locator("textarea").count() == 0, "no 'Maybe' option and no note box")
    check(page.locator(".chip:has-text('Submitted')").count() == 1, "'Submitted' chip is on the page (top right), no Edit step")
    sen_first = sen.locator(".drow").first
    jun_first = jun.locator(".drow", has_text=date_part).first
    check("on" in sen_first.locator("button.opt.yes").get_attribute("class"), "existing Senior answer is pre-highlighted")
    jun_before = jun_first.locator("button.opt.no").get_attribute("class")
    sen_first.locator("button.opt.no").click()
    check("on" in sen_first.locator("button.opt.no").get_attribute("class") and "on" not in sen_first.locator("button.opt.yes").get_attribute("class"), "tapping highlights the new choice only")
    check(jun_first.locator("button.opt.no").get_attribute("class") == jun_before, "changing Senior leaves the Junior answer for the same day alone")
    check(page.locator(".chip:has-text('Unsaved changes')").count() == 1, "chip warns about unsaved changes")
    page.click(".savebar button:has-text('Save')")
    page.wait_for_selector(".chip:has-text('Submitted')")
    check(True, "one Save updates the whole season and the chip returns to Submitted")
    page.reload()
    page.wait_for_selector(".tile")
    sen = page.locator(".comp-section:has(h2:has-text('Senior'))")
    jun = page.locator(".comp-section:has(h2:has-text('Junior'))")
    check("on" in sen.locator(".drow").first.locator("button.opt.no").get_attribute("class"), "answer is still there after reloading")
    check("on" in jun.locator(".drow", has_text=date_part).first.locator("button.opt.no").get_attribute("class"), "Junior 'not available' for the same day was kept separately")
    row3 = sen.locator(".drow").nth(3)
    if "on" in row3.locator("button.opt.yes").get_attribute("class"):
        row3.locator("button.opt.yes").click()          # clear any existing answer first
    row3.locator("button.opt.yes").click()
    check("on" in row3.locator("button.opt.yes").get_attribute("class"), "tapping an option selects it")
    row3.locator("button.opt.yes").click()
    check("on" not in sen.locator(".drow").nth(3).locator("button.opt.yes").get_attribute("class"), "tapping the same option again clears it")
    sen.locator("button:has-text('Mark all available')").click()
    check(sen.locator("button.opt.yes.on").count() == 12, "'Mark all available' answers every Senior date")
    check(jun.locator("button.opt.yes.on").count() < jun.locator(".drow").count(), "...and leaves the other competitions alone")
    page.click(".savebar button:has-text('Save')")
    page.wait_for_selector(".chip:has-text('Submitted')")

    print("Admin sees the season-wide answers")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    def avail_cell(comp, prefix):
        page.locator(f".comp-tile:has(h2:has-text('{comp}')) a.tile-body").first.click()
        page.wait_for_selector("table.board")
        page.click("a.tab:has-text('Availability')")
        page.wait_for_selector("td.av")          # the availability grid itself, not the board still on screen
        heads = page.locator("table.board thead th").all_inner_texts()
        i = next(i for i, t in enumerate(heads) if date_part.lower() in t.lower())
        cls = page.locator("tr:has-text('Demo Umpire 1')").first.locator("td").nth(i).get_attribute("class")
        return cls
    check("ok" in avail_cell("Senior", "senior"), "umpire 1 is available for the Senior game that day")
    check(page.locator("text=Haven't replied (2)").count() == 1, "still two umpires with no reply")
    page.click("a.tab:has-text('All rounds')")
    page.wait_for_selector(".comp-tile")
    check("no" in avail_cell("Junior", "junior"), "...but not available for the Junior game the same day")
    page.click("a.tab:has-text('All rounds')")

    print("Admin: past allocations stay available")
    page.goto(BASE + "#/admin")
    page.wait_for_selector(".tile-round")
    check("Past allocations (3)" in page.locator(".past-rounds summary").inner_text(), "sample data includes three finished rounds under Past allocations")
    page.click(".past-rounds summary")
    rows = page.locator(".past-row").all_inner_texts()
    check("14 NOV" in rows[0].upper() and "Junior" in rows[0] and "Not published" in rows[0] and "1/2 slots filled" in rows[0], "newest first: Junior 14 Nov, part filled, not published")
    check(any("7/14 NOV" in r.upper() and "Senior" in r and "8/8 slots filled" in r and "Published" in r for r in rows), "Senior 7/14 Nov: 8/8 slots filled, Published")
    page.screenshot(path="/tmp/past.png")
    page.locator(".past-row", has_text="Senior").click()
    page.wait_for_selector(".report-table")
    check(page.locator(".report-table tbody tr").count() == 4 and "DEMO UMPIRE" in page.locator(".report-table").inner_text().upper(), "opening it shows the final allocation report with the umpires' names")
    page.goto(BASE + "#/admin")
    page.wait_for_selector(".tile-round")

    print("Admin: season availability dashboard")
    page.click(".nav-link:has-text('Availability')")
    page.wait_for_selector(".season-grid table")
    check(page.locator(".tabs button.tab").all_inner_texts() == ["Senior", "Junior", "T20"], "dashboard has a tab per competition: Senior, Junior, T20")
    check(page.locator(".season-grid tbody tr").count() == 10, "one row per active umpire")
    n_dates = page.locator(".season-grid .datebtn").count()
    check(n_dates == 12 and page.locator(".season-grid th.past").count() == 0, "Senior: one column per upcoming date, nothing greyed out to scroll past")
    check(page.locator(".season-grid thead", has_text="Round").count() == 0, "no round columns: every competition is laid out by date")
    check(page.locator(".season-grid tr.counts td").count() == n_dates + 1, "a count of available umpires sits under each date")
    row9 = page.locator(".season-grid tbody tr:has-text('Demo Umpire 9')")
    check("0 of" not in row9.inner_text() and "0/12" in row9.inner_text(), "each umpire shows how many upcoming dates they are free (0/12 for one who has not answered)")
    before = int(page.locator(".season-grid tr.counts td").nth(1).inner_text())
    c0 = row9.locator("td.av").first
    c0.locator("button").click()
    page.wait_for_function("() => document.querySelector(\".season-grid tbody tr:nth-child(10) td.av\").classList.contains('ok')")
    check("ok" in c0.get_attribute("class") and "edited" in c0.locator("button").get_attribute("class"), "officer clicks a blank cell: it becomes available and is marked as set by the officer")
    check(int(page.locator(".season-grid tr.counts td").nth(1).inner_text()) == before + 1 and "1/12" in row9.inner_text(), "the date's count and the umpire's tally update")
    c0.locator("button").click()
    page.wait_for_timeout(300)
    check("no" in c0.get_attribute("class"), "a second click makes it not available")
    page.reload()
    page.wait_for_selector(".season-grid table")
    check("no" in page.locator(".season-grid tbody tr:has-text('Demo Umpire 9') td.av").first.get_attribute("class"), "the override is saved")
    page.locator(".season-grid .datebtn").first.click()
    shown = page.locator(".season-grid tbody tr").count()
    check(0 < shown < 10 and page.locator(".season-grid tbody td.av.ok").count() >= shown, "clicking a date lists only the umpires available that day")
    page.locator("button.chip:has-text('Available')").click()
    page.fill(".grid-search", "umpire 1")
    check(page.locator(".season-grid tbody tr").count() == 2, "search narrows the list (Demo Umpire 1 and 10)")
    page.fill(".grid-search", "")
    page.click(".tabs button.tab:has-text('Junior')")
    check(page.locator(".season-grid .datebtn").count() > 3 and page.locator(".season-grid thead", has_text="Round").count() == 0, "Junior uses the same date layout")
    page.click(".tabs button.tab:has-text('Senior')")
    page.screenshot(path="/tmp/season.png")

    print("Umpire: new sign-up + approval")
    sign_out(page)
    sign_in(page, "newbie@demo.test")
    page.wait_for_selector("form input")
    page.locator("form input").nth(0).fill("New")
    page.locator("form input").nth(1).fill("Umpire")
    page.click("button:has-text('Save')")
    page.wait_for_selector("text=waiting for approval")
    check(True, "new umpire sees waiting-for-approval notice")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.click(".nav-link:has-text('Members')")
    page.wait_for_selector("table.board")
    check(page.locator("h1").first.inner_text() == "Members", "the Umpires page is now called Members")
    check(page.locator("table.members thead th").all_inner_texts() == ["ACTIVE", "FIRST NAME", "LAST NAME", "D.O.B", "ADDRESS", "EMAIL", "MOBILE", "ACCREDITATION NO.", "MEMBERSHIP"],
          "members have a first and last name, date of birth, address, accreditation number and membership type")
    acc = page.locator("tr:has-text('umpire1@demo.test') input").nth(6)
    acc.fill("L2-9001"); acc.blur(); page.wait_for_timeout(250)
    page.reload(); page.wait_for_selector("table.members")
    check(page.locator("tr:has-text('umpire1@demo.test') input").nth(6).input_value() == "L2-9001", "the accreditation number is saved")
    check(page.locator("text=1 member(s) are waiting for approval").count() == 1, "officer sees the pending member")
    row = page.locator("tr.needs")
    check(row.locator("input").nth(1).input_value() == "New" and row.locator("input").nth(2).input_value() == "Umpire", "the name they typed is split into the two fields")
    row.locator("input[type=date]").fill("1990-04-21")
    row.locator("input[type=date]").blur()
    row.locator("input[aria-label=address]").fill("12 Pitch St, Parramatta")
    row.locator("input[aria-label=address]").blur()
    page.wait_for_timeout(300)
    page.reload()
    page.wait_for_selector("table.members")
    row = page.locator("tr.needs")
    check(row.locator("input[type=date]").input_value() == "1990-04-21" and "Pitch St" in row.locator("input[aria-label=address]").input_value(), "date of birth and address are saved")
    row.locator("input[type=checkbox]").click()
    page.wait_for_function("() => !document.querySelector('tr.needs')")
    check(True, "approving moves the member to active")
    page.locator("tr:has-text('newbie@demo.test') input").nth(2).fill("Newman")
    page.locator("tr:has-text('newbie@demo.test') input").nth(2).blur()
    page.wait_for_timeout(300)
    page.reload()
    page.wait_for_selector("table.members")
    check(page.locator("tr:has-text('newbie@demo.test') input").nth(2).input_value() == "Newman", "an officer can correct a member's name")
    page.fill("textarea", "Pat, Example, pat@example.com, 0400 000 000, L3-7782\nbad line")
    page.click("button:has-text('Add members')")
    page.wait_for_selector("td:has-text('pat@example.com')")
    pat = page.locator("tr:has-text('pat@example.com') input")
    check(pat.nth(1).input_value() == "Pat" and pat.nth(2).input_value() == "Example" and pat.nth(5).input_value() == "0400 000 000" and pat.nth(6).input_value() == "L3-7782", "bulk add reads First name, Last name, email, mobile and accreditation number")
    page.goto(BASE + "#/admin/members")
    page.wait_for_selector("table.members")
    check(page.locator("h1").first.inner_text() == "Members", "the old /admin/umpires link still opens it")

    print("Admin: membership settings")
    page.click(".nav-link:has-text('Settings')")
    page.wait_for_selector(".type-rows")
    rows = page.locator(".type-row")
    check(rows.count() == 3 and rows.first.locator("input").first.input_value() == "Ordinary member" and rows.first.locator("input[type=number]").input_value() == "60",
          "Settings lists the membership types with their own fees")
    page.click("button:has-text('Add type')")
    page.locator(".type-row").last.locator("input").first.fill("Student member")
    page.locator(".type-row").last.locator("input[type=number]").fill("15")
    check(page.locator(".daymonth select").count() == 2 and page.locator("input[type=date]").count() == 0, "the renewal date is a day and a month, with no year")
    check(page.locator(".daymonth select").nth(0).input_value() == "30" and page.locator(".daymonth select").nth(1).input_value() == "06", "it starts on the association's own renewal day")
    page.locator(".daymonth select").nth(1).select_option("02")
    check(page.locator(".daymonth select").nth(0).locator("option").count() == 30, "February offers 29 days (plus the blank)")
    page.locator(".daymonth select").nth(1).select_option("09")
    page.locator(".daymonth select").nth(0).select_option("01")
    page.click("button:has-text('Save membership')")
    page.wait_for_selector(".toast:has-text('Membership saved')")
    page.reload()
    page.wait_for_selector(".type-rows")
    check(page.locator(".type-row").count() == 4 and page.locator(".daymonth select").nth(0).input_value() == "01" and page.locator(".daymonth select").nth(1).input_value() == "09", "the renewal day and the new type are saved")
    page.locator(".type-row").last.locator("button:has-text('Remove')").click()
    page.click("button:has-text('Save membership')")
    page.wait_for_selector(".toast:has-text('Membership saved')")
    check(page.locator(".type-row").count() == 3, "a type can be removed again")

    print("Members: membership type and fee")
    page.click(".nav-link:has-text('Members')")
    page.wait_for_selector("table.members")
    check("Membership renews 1 September each year" in page.inner_text("body"), "the Members page shows when membership falls due")
    sel = page.locator("tr:has-text('umpire1@demo.test') select")
    check(sel.locator("option").all_inner_texts() == ["\u2014", "Ordinary member", "Junior member", "Life member"], "the dropdown offers the types set up in Settings")
    sel.select_option("Junior member")
    page.wait_for_timeout(300)
    page.reload()
    page.wait_for_selector("table.members")
    row1 = page.locator("tr:has-text('umpire1@demo.test')")
    check(row1.locator("select").input_value() == "Junior member" and "$25" in row1.inner_text(), "the choice is saved and the type's fee is shown")

    print("Availability: import a season from a spreadsheet")
    page.click(".nav-link:has-text('Availability')")
    page.wait_for_selector(".season-grid")
    before_rows = page.locator(".season-grid tbody tr").count()
    page.click(".import-card summary")
    cal = page.evaluate("() => JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.season.calendar.filter(e => (e.comp || 'senior') === 'senior').slice(0, 2)")
    def heading(entry):
        ds = [date.fromisoformat(x) for x in entry["dates"]]
        return f"{entry.get('label', '')} - " + " & ".join(f"{d.day}th" for d in ds) + " " + ds[0].strftime("%b")
    sheet = ("Name\tEmail\t" + "\t".join(heading(e) for e in cal)
             + "\nDemo Umpire 10\tumpire10@demo.test\tDay 1, Day 2\tNot Available"
             + "\nSam Casual\tsam.casual@demo.test\tYes\tYes"
             + "\nNo Address\t\tYes\tYes")
    page.fill(".import-card textarea", sheet)
    page.click("button:has-text('Check it')")
    page.wait_for_selector(".import-out table")
    out = page.inner_text(".import-out")
    check(f"{len(cal)} columns matched to dates" in out, "the preview says which columns it matched to dates")
    check("1 of 3 people matched a member" in out and "Sam Casual" in out and "No Address" in out, "it says who it could not find on the Members list")
    check("cannot be added because the sheet has no email" in out, "and which of them cannot be added")
    page.check(".import-card input[type=checkbox]")
    page.click("button:has-text('Import')")
    page.wait_for_selector(".toast:has-text('imported')")
    check("2 imported, 1 added as non-members, 1 skipped" in page.locator(".toast").last.inner_text(), "two are imported and the stranger with an email is added")
    page.wait_for_selector(".season-grid tr.nonmember")
    check(page.locator(".season-grid tbody tr").count() == before_rows + 1 and page.locator("tr.nonmember:has-text('Sam Casual')").count() == 1,
          "the new person is in the sheet, marked Non-member")
    check("1 non-member" in page.inner_text(".summary"), "the summary counts them separately")
    d1 = date.fromisoformat(cal[0]["dates"][0]).strftime("%-d")
    imported = page.evaluate("""() => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        return { u10: db.availability['s-2026-27__umpire10@demo.test'] || Object.values(db.availability).find(a => a.email === 'umpire10@demo.test'),
                 sam: Object.values(db.availability).find(a => a.email === 'sam.casual@demo.test') };
      }""")
    first, second = cal[0]["dates"][0], cal[1]["dates"][0]
    check(imported["u10"]["days"][f"senior:{first}"] == "yes" and imported["u10"]["days"][f"senior:{second}"] == "no",
          "a member who had answered nothing now has the sheet's answers")
    check(imported["sam"]["days"][f"senior:{first}"] == "yes", "so does the new non-member")

    print("Allocate: a non-member is offered in a group of their own")
    page.goto(BASE + "#/admin")
    page.wait_for_selector(".comp-tile")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    groups = page.locator("select.slot").first.evaluate("s => [...s.querySelectorAll('optgroup')].map(g => g.label)")
    check("Available Non-Member" in groups, f"the dropdown has an Available Non-Member group: {groups}")
    opt = page.locator("select.slot").first.evaluate("s => { const g = [...s.querySelectorAll('optgroup')].find(g => g.label === 'Available Non-Member'); return g ? { text: g.children[0].text, value: g.children[0].value } : null }")
    check(opt and "Sam Casual" in opt["text"], "with the non-member in it")
    page.locator("select.slot").first.select_option(value=opt["value"])
    page.wait_for_timeout(300)
    check(page.locator(".warn-icon").count() >= 1, "choosing them raises a warning like the others")
    page.click("details:has-text('Show warnings') summary")
    check("Not an active member" in page.inner_text("details:has-text('Show warnings')"), "the warning says they are not an active member")
    page.locator("select.slot").first.select_option(value="")
    page.wait_for_timeout(300)
    page.click(".publish button:has-text('Re-publish')")
    page.wait_for_selector(".publish button:disabled")

    print("Umpire turns down an appointment from their own page")
    appt = page.evaluate("""(today) => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        const r = Object.values(db.rounds).find(x => x.published && x.comp === 'senior' && x.end >= today);
        for (const g of Object.values(db.games[r.id] || {})) {
          for (const [d, arr] of Object.entries(g.alloc || {})) {
            const a = (arr || []).find(Boolean);
            if (a && d >= today) { const u = Object.values(db.umpires).find(u => u.pid === a.p);
              return { email: u.email, name: u.name, date: d, roundId: r.id, gameId: g.id }; }
          }
        }
        return null;
      }""", today.isoformat())
    before_mail = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.mail || {}).length")
    sign_out(page)
    sign_in(page, appt["email"])
    page.wait_for_selector(".appt")
    check(page.locator(".appt").count() >= 1, "the umpire sees their appointments")
    row = page.locator(".appt").first
    check(row.locator("button:has-text(\"I can't do this\")").count() == 1, "each appointment has an 'I can't do this' button")
    appt_date = row.locator(".appt-date strong").inner_text()
    row.locator("button:has-text(\"I can't do this\")").click()
    page.wait_for_selector(".appt.declined")
    check("You said you can't do this" in page.locator(".appt.declined").first.inner_text(), "turning it down is marked on the appointment")
    now_mail = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.mail || {})")
    check(len(now_mail) == before_mail + 1 and appt["name"] in now_mail[-1]["message"]["subject"], "the officer is emailed")
    sec = page.locator(f".comp-section:has(h2:has-text('Senior')) .drow:has-text('{appt_date}')").first
    check(sec.locator("button.opt.no.on").count() == 1, "their availability for that day is now 'Not available'")
    page.reload()
    page.wait_for_selector(".appt")
    check(page.locator(".appt.declined").count() >= 1 and page.locator(f".comp-section:has(h2:has-text('Senior')) .drow:has-text('{appt_date}') button.opt.no.on").count() == 1,
          "it is still saved after a reload")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".dropouts")
    check(appt["name"] in page.locator(".dropouts").inner_text(), "the officer sees it on Allocate")
    freed = page.evaluate("""(a) => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        return (db.games[a.roundId][a.gameId].alloc[a.date] || []).some(x => x && x.n === a.name);
      }""", appt)
    check(not freed, "and the slot is free again")
    page.click(".dropouts button:has-text('Got it')")

    print("Umpire pulls out of a published game")
    info = page.evaluate("""(today) => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        const r = Object.values(db.rounds).find(x => x.published && x.comp === 'senior' && x.end >= today);
        for (const g of Object.values(db.games[r.id] || {})) {
          for (const [d, arr] of Object.entries(g.alloc || {})) {
            const a = (arr || []).find(Boolean);
            if (a && d >= today) { const u = Object.values(db.umpires).find(u => u.pid === a.p);
              return { email: u.email, name: u.name, date: d, roundId: r.id, gameId: g.id }; }
          }
        }
        return null;
      }""", today.isoformat())
    check(bool(info), f"a published Senior game has an umpire on it ({info and info['name']})")
    d = date.fromisoformat(info["date"])
    label = d.strftime("%a, ") + str(d.day) + d.strftime(" %b")
    sign_out(page)
    sign_in(page, info["email"])
    page.wait_for_selector(".comp-section")
    page.locator(f".comp-section:has(h2:has-text('Senior')) .drow:has-text('{label}')").first.locator("button.opt.no").click()
    page.click(".savebar button:has-text('Save')")
    page.wait_for_selector(".toast")
    check("appointments officer has been told" in page.locator(".toast").inner_text(), "the umpire is told their change affects a game they were given")
    mail = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.mail || {})")
    check(len(mail) >= 1 and mail[-1]["to"] == "admin@demo.test" and info["name"] in mail[-1]["message"]["subject"], f"an email to the officer is queued ({len(mail)})")
    check(label.split(", ")[1] in mail[-1]["message"]["text"], "the email lists the date and game")
    page.click(".savebar button:has-text('Save')")
    page.wait_for_timeout(500)
    again = page.evaluate("() => Object.values(JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca.mail || {}).length")
    check(again == len(mail), "saving again with no change does not email the officer twice")

    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".dropouts")
    check(info["name"] in page.locator(".dropouts").inner_text(), "the officer sees a banner on Allocate naming who pulled out")
    freed = page.evaluate("""(info) => {
        const db = JSON.parse(localStorage.getItem('pdca-umpires-demo-v2')).orgs.pdca;
        const g = db.games[info.roundId][info.gameId];
        return { still: (g.alloc[info.date] || []).some(a => a && a.n === info.name), note: g.changeNote || '' };
      }""", info)
    check(not freed["still"], "the slot is unallocated again")
    check(info["name"] in freed["note"] and "no longer available" in freed["note"], "the game carries a note for the officer")
    page.locator(".dropouts a").first.click()
    page.wait_for_selector("table.board")
    check(page.locator(".change:has-text('no longer available')").count() >= 1, "the board flags the game")
    page.click("a.tab:has-text('All rounds')")
    page.wait_for_selector(".comp-tile")
    check(page.locator(".dropouts").count() == 1, "the banner is still there until the officer dismisses it")
    page.click(".dropouts button:has-text('Got it')")
    check(page.locator(".dropouts").count() == 0, "the banner can be dismissed")
    page.reload()
    page.wait_for_selector(".comp-tile")
    check(page.locator(".dropouts").count() == 0, "and it does not come back: the withdrawal is handled")

    print("Admin: fixtures load automatically from Play Cricket (mocked service)")
    API_DOWN = False
    page.locator("button:has-text('Reset')").click()      # demo reset: start from an empty app
    page.wait_for_timeout(500)
    if page.locator(".who").count():
        sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".tile-round")
    check(page.locator(".comp-tile h2").all_inner_texts() == ["Senior", "Junior", "Senior", "T20"], "no button needed: next rounds appear by themselves; Senior has a second tile for its one-day Women's game")
    check("Two Day" in tile("Senior", 0).inner_text() and "28 NOV" in tile("Senior", 1).inner_text().upper() and "T20" in tile("Senior", 1).inner_text() and "Two Day" not in tile("Senior", 1).inner_text(), "second Senior tile: its own date and its own match type (T20 in the mock)")
    open_grades("Senior", 1)
    check(dlg.locator(".grade-row").count() == 1 and "Women" in dlg.locator(".grade-row").first.inner_text(), "its popup lists only the grade that plays then (Senior Women)")
    dlg.locator("button:has-text('Cancel')").click()
    dlg.wait_for(state="detached")
    back_to_rounds()
    check(page.locator("button:has-text('Load more')").count() == 1, "Load more is offered: later rounds exist")
    page.click("button:has-text('Load more')")
    check(page.locator(".comp-tile").count() > 4, "Load more reveals more round tiles")
    while page.locator("button:has-text('Load more')").count():
        page.click("button:has-text('Load more')")
    check(page.locator(".comp-tile:has(h2:has-text('Senior'))").count() == 3, "all Senior rounds are reachable (three here)")
    check("21/28 NOV" in tile("Senior").inner_text().upper() and "28 NOV" in tile("T20").inner_text().upper(), "each competition shows the dates of its own next round")
    check(page.locator("text=Updating fixtures").count() == 0, "loading finished")
    check("0 grades" in tile("Senior").inner_text() and "0/0 slots filled" in tile("Senior").inner_text(), "nothing is picked until the officer picks grades")
    open_grades("Senior")
    check(dlg.locator(".grade-row").count() == 2, "Senior popup lists the 2 grades playing this round")
    dlg.locator("button:has-text('All')").click()
    check("2 grades" in dlg.inner_text() and "4 umpire slots" in dlg.inner_text(), "All = 2 grades, 4 umpire slots (two-day games)")
    dlg.locator("button:has-text('Done')").click()
    dlg.wait_for(state="detached")
    back_to_rounds()
    check("0/4 slots filled" in tile("Senior").inner_text(), "tile shows 0/4 slots filled")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    check(page.locator("table.board tbody tr").count() == 2 and page.locator("a[href*='google.com/maps']").count() == 2, "board lists the 2 Senior games with map links from the service")

    print("Admin: update fixtures picks up a ground change")
    API["g-a"][0]["venue"]["name"] = "New Ground"
    API["g-a"][0]["venue"]["playingSurface"]["name"] = "New Ground"
    page.click("button:has-text('Update fixtures')")
    page.wait_for_selector(".change")
    check("Ground" in page.locator(".change").first.inner_text(), "ground change is flagged on the game")

    print("New umpire sees the dates from the same fetch")
    sign_out(page)
    sign_in(page, "umpire2@demo.test")
    page.wait_for_selector("form input")
    page.locator("form input").nth(0).fill("Umpire")
    page.locator("form input").nth(1).fill("Two")
    page.click("button:has-text('Save')")
    page.wait_for_selector(".tile")
    check(page.locator(".comp-title").all_inner_texts() == ["Senior", "T20", "Junior"], "umpire sees Senior, T20 and Junior sections")
    check(page.locator(".drow").count() == 7, "umpire sees the 7 synced dates")
    check(page.locator(".comp-section:has(h2:has-text('Junior')) .drow").count() == 3, "Junior: its 3 dates, even though U14 is two-day and U13 one-day")
    check(page.locator(".comp-section:has(h2:has-text('Senior'))").get_by_text("Round").count() == 0 and page.locator(".comp-section:has(h2:has-text('Junior'))").get_by_text("Round").count() == 0, "mixed-length competitions have no round text")
    check(page.locator(".comp-section:has(h2:has-text('T20'))").get_by_text("Round 1").count() == 1, "the all-one-day T20 competition is shown by round")
    check(page.locator(".dlabel", has_text=fmt_day_check()).count() == 1, "a date plays out as just the date")
    check(page.locator(".chip:has-text('Not submitted')").count() == 1, "a fresh season starts as 'Not submitted'")

    print("Mobile layout")
    m = ctx.new_page()
    m.set_viewport_size({"width": 390, "height": 800})
    m.goto(BASE + "#/")
    m.wait_for_selector(".tile")
    overflow = m.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
    check(not overflow, "availability page does not scroll sideways on a phone")
    check(m.locator(".savebar").is_visible(), "Save bar is visible without scrolling on a phone")
    m.close()

    print("Sample data pulls the real fixtures when Play Cricket is reachable (mocked)")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.click("button:has-text('Load sample data')")
    page.wait_for_selector("text=Loaded the real PDCA fixtures")
    check(True, "sample data announces it used the real fixtures")
    page.wait_for_selector(".tile-round")
    check("0/" in tile("Senior").inner_text() and "grades" in tile("Senior").inner_text(), "sample Senior tile already has grades picked")
    tile("Senior").locator("a.tile-body").click()
    page.wait_for_selector("table.board")
    check(page.locator("td:has-text('Pearce Reserve'), td:has-text('New Ground')").count() >= 1, "board shows the real (mocked) grounds")

    print("Demo: an umpire on a fresh browser still gets the availability page")
    fresh = browser.new_context(viewport={"width": 1280, "height": 900})
    fp = fresh.new_page()
    fp.on("dialog", lambda d: d.accept())
    fp.route("https://grassrootsapiproxy.cricket.com.au/**", lambda r: r.abort())
    fp.goto(BASE + "#/")
    fp.wait_for_selector("#login-email")
    fp.fill("#login-email", "umpire1@demo.test")
    fp.click("button:has-text('Sign in')")
    fp.wait_for_selector("form input")
    check(fp.locator("#org-name").count() == 0 and "Parramatta" in fp.locator(".org-name").inner_text(), "no 'Start a new association' page: the demo opens its built-in association")
    fp.click("button:has-text('Load sample data')")
    fp.wait_for_selector(".drow")
    check(fp.locator(".comp-title").count() == 3 and fp.locator("button.opt.yes").count() > 10, "after Load sample data the umpire sees the date-by-date availability page")
    fresh.close()

    print("Associations: settings, officers, join link")
    page.goto(BASE + "#/admin")
    page.wait_for_selector(".tile-round")
    check("Parramatta District Cricket Association" in page.locator(".org-name").inner_text(), "the header names the association in use")
    page.click(".nav-link:has-text('Settings')")
    page.wait_for_selector(".join-link")
    check(page.locator(".join-link").inner_text().endswith("#/join/pdca"), "Settings shows the link umpires join with")
    check("Free trial" in page.locator("h1 + .chip, .row-between .chip").first.inner_text(), "Settings shows the plan (free trial)")
    page.fill(".inline-form input[type=email]", "Second.Officer@demo.test")
    page.click("button:has-text('Add officer')")
    page.wait_for_selector(".officers li:has-text('second.officer@demo.test')")
    check(page.locator(".officers li").count() == 2 and page.locator(".officers li:has-text('admin@demo.test')").locator("text=you").count() == 1, "an officer can add another officer; you cannot remove yourself")

    print("Associations: a second association is completely separate")
    sign_out(page)
    sign_in(page, "founder@demo.test")
    page.goto(BASE + "#/associations")
    page.wait_for_selector("#org-name")
    check(page.locator(".org-tile").count() == 0, "a new person belongs to no association yet")
    page.fill("#org-name", "Hills Cricket Association")
    page.fill("#org-pc", "not a link")
    page.click("button:has-text('Create association')")
    page.wait_for_selector(".toast.err, .toast")
    check(page.locator("#org-name").count() == 1, "a bad Play Cricket link is refused")
    page.fill("#org-pc", "https://play.cricket.com.au/club/hills/11111111-2222-3333-4444-555555555555?tab=grades")
    page.click("button:has-text('Create association')")
    page.wait_for_selector(".tile-round")
    check("Hills Cricket Association" in page.locator(".org-name").inner_text(), "creating an association opens it, with the creator as its officer")
    check(page.locator(".past-rounds summary").inner_text().strip() == "Past allocations (0)", "it starts with no history of its own")
    hills = page.evaluate("localStorage.getItem('pdca-org')")
    check(hills.startswith("hills-cricket-association-"), "it gets its own id")
    page.goto(BASE + "#/admin/members")
    page.wait_for_selector("textarea")
    check(page.locator("td:has-text('@demo.test')").count() == 0, "its umpire list is empty: PDCA's umpires are not visible")
    page.goto(BASE + "#/admin/settings")
    page.wait_for_selector(".officers")
    check(page.locator(".officers li").count() == 1 and "founder@demo.test" in page.locator(".officers").inner_text(), "its only officer is the founder")

    print("Associations: an umpire joins by link; people land in their own association")
    sign_out(page)
    sign_in(page, "hillsump@demo.test")
    page.goto(BASE + "#/join/" + hills)
    page.wait_for_selector("form input")
    check("Hills Cricket Association" in page.locator(".org-name").inner_text(), "the join link opens that association")
    page.locator("form input").nth(0).fill("Hills")
    page.locator("form input").nth(1).fill("Umpire")
    page.click("button:has-text('Save')")
    page.wait_for_selector("text=waiting for approval")
    sign_out(page)
    sign_in(page, "founder@demo.test")
    page.goto(BASE + "#/admin/members")
    page.wait_for_selector("tr.needs")
    check(page.locator("tr.needs:has-text('hillsump@demo.test')").count() == 1 and page.locator("table.board tbody tr").count() == 1, "the Hills officer sees the new umpire waiting for approval")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".tile-round")
    check("Parramatta" in page.locator(".org-name").inner_text(), "the PDCA officer lands back in PDCA, not the association last used on this computer")
    page.goto(BASE + "#/admin/members")
    page.wait_for_selector("table.board")
    check(page.locator("td:has-text('hillsump@demo.test')").count() == 0 and page.locator("td:has-text('umpire1@demo.test')").count() == 1, "PDCA sees its own umpires and not the Hills umpire")
    page.goto(BASE + "#/join/" + hills)
    page.wait_for_selector("form input")
    check(page.locator(".nav").count() == 0, "a PDCA officer who opens the Hills link is just a new umpire there, with no officer pages")
    page.goto(BASE + "#/associations")
    page.wait_for_selector(".org-tile")
    check(page.locator(".org-tile").count() == 2, "the picker lists both associations for someone in both")
    page.locator(".org-tile:has-text('Parramatta')").click()
    page.wait_for_selector(".tile-round")
    check("Parramatta" in page.locator(".org-name").inner_text(), "switching back works")

    browser.close()

httpd.shutdown()
print(f"\n{passed} checks passed")
real = [e for e in errors if not e.startswith("FAIL")]
if errors:
    print("\nProblems:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
