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


socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("", PORT), Quiet)
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
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "ERR_" not in m.text and "Failed to fetch" not in m.text else None)
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("dialog", lambda d: d.accept())
    page.route("https://grassrootsapiproxy.cricket.com.au/**", fulfill_api)

    print("Admin: Rounds page, one tile per competition")
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".comp-tile")
    check(page.locator("text=Season dates").count() == 0 and page.locator("text=New round").count() == 0 and page.locator("text=Re-sync").count() == 0, "no Season dates card, Re-sync or New round button")
    page.wait_for_selector(".notice.warn:has-text('Could not load the fixtures')")
    check(True, "with Play Cricket unreachable the officer gets a clear message and a retry link")
    page.click("button:has-text('Load sample data')")
    page.wait_for_selector(".tile-round")
    check(page.locator(".comp-tile h2").all_inner_texts() == ["Senior", "T20", "Junior"], "three tiles: Senior, T20, Junior")
    tile = lambda name: page.locator(f".comp-tile:has(h2:has-text('{name}'))")
    sen_t = tile("Senior").inner_text()
    check(re.search(r"\d+/\d+ NOV", sen_t.upper()) and "ROUND" not in sen_t.upper(), "tile headline is the dates, not the round name")
    check("5 grades" in sen_t and "0/26 slots filled" in sen_t, "Senior tile: 5 grades, 0/26 slots filled")
    check("Two Day" in sen_t and "Mens" not in sen_t and "Women" not in sen_t, "Senior tile shows Play Cricket's own match type: Two Day (no made-up grade groups)")
    check("T20" in tile("T20").inner_text().replace("T20\n", "", 1), "T20 tile shows the match type T20")
    check("One Day & Two Day" in tile("Junior").inner_text(), "Junior tile shows its match types before any grade is picked: One Day & Two Day")
    check("2 grades" in tile("T20").inner_text() and "0/4 slots filled" in tile("T20").inner_text(), "T20 tile: 2 grades, 0/4 slots filled")
    check("0 grades" in tile("Junior").inner_text() and "0/0 slots filled" in tile("Junior").inner_text() and tile("Junior").locator(".chip").count() == 2, "Junior tile with nothing picked still shows the same two tags: 0 grades, 0/0 slots filled")
    check(page.locator("a.tile-body").count() == 3, "each tile opens its own round")

    print("Admin: Select grades")
    tile("Junior").locator("button:has-text('Select grades')").click()
    dlg = page.locator("dialog.modal")
    dlg.wait_for(state="visible")
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
    check("2 grades" in tile("Junior").inner_text() and "0/4 slots filled" in tile("Junior").inner_text(), "Junior tile updates to 2 grades, 0/4 slots filled")
    check("One Day & Two Day" in tile("Junior").inner_text(), "picking U12 (One Day) and U14 (Two Day) keeps One Day & Two Day")
    tile("Junior").locator("button:has-text('Select grades')").click()
    dlg.wait_for(state="visible")
    check(dlg.locator(".grade-row:has-text('U14') input[type=checkbox]").is_checked(), "ticked grades stay ticked when the popup is reopened")
    check([t.split()[0] for t in dlg.locator(".grade-row .chip").all_inner_texts()] == ["U14", "U12"], "Junior grades are listed oldest age group first (U14 before U12)")
    dlg.locator("button:has-text('None')").click()
    check("No grades selected" in dlg.inner_text(), "the None link clears every grade")
    dlg.locator(".grade-row:has-text('U12') input[type=checkbox]").check()
    dlg.locator("button:has-text('Done')").click()
    dlg.wait_for(state="detached")
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
    check(page.locator(".report-table tbody tr").count() == 13, "report lists the 13 Senior games")
    check(page.locator(".report-table th:has-text('UMPIRES')").count() == 1, "one report table for the Senior round")
    page.click("a.tab:has-text('Allocate')")
    page.wait_for_selector("table.board")
    page.locator(".toggle:has-text('Published') input").check()

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
        page.locator(f".comp-tile:has(h2:has-text('{comp}')) a.tile-body").click()
        page.wait_for_selector("table.board")
        page.click("a.tab:has-text('Availability')")
        page.wait_for_selector("table.board")
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

    print("Umpire: new sign-up + approval")
    sign_out(page)
    sign_in(page, "newbie@demo.test")
    page.wait_for_selector("form input")
    page.locator("form input").first.fill("New Umpire")
    page.click("button:has-text('Save')")
    page.wait_for_selector("text=waiting for approval")
    check(True, "new umpire sees waiting-for-approval notice")
    sign_out(page)
    sign_in(page, "admin@demo.test")
    page.goto(BASE + "#/admin/umpires")
    page.wait_for_selector("table.board")
    check(page.locator("text=1 umpire(s) are waiting for approval").count() == 1, "officer sees pending umpire")
    page.locator("tr.needs input[type=checkbox]").click()
    page.wait_for_function("() => !document.querySelector('tr.needs')")
    check(True, "approving moves the umpire to active")
    page.fill("textarea", "Pat Example, pat@example.com, 0400 000 000\nbad line")
    page.click("button:has-text('Add umpires')")
    page.wait_for_selector("td:has-text('pat@example.com')")
    check(page.locator("text=pat@example.com").count() == 1, "bulk add creates the umpire")

    print("Admin: fixtures load automatically from Play Cricket (mocked service)")
    API_DOWN = False
    page.locator("button:has-text('Reset')").click()      # demo reset: start from an empty app
    page.wait_for_timeout(500)
    if page.locator(".who").count():
        sign_out(page)
    sign_in(page, "admin@demo.test")
    page.wait_for_selector(".tile-round")
    check(page.locator(".comp-tile h2").all_inner_texts() == ["Senior", "T20", "Junior"], "no button needed: the three next rounds appear by themselves")
    check("21/28 NOV" in tile("Senior").inner_text().upper() and "28 NOV" in tile("T20").inner_text().upper(), "each competition shows the dates of its own next round")
    check(page.locator("text=Updating fixtures").count() == 0, "loading finished")
    check("0 grades" in tile("Senior").inner_text() and "0/0 slots filled" in tile("Senior").inner_text(), "nothing is picked until the officer picks grades")
    tile("Senior").locator("button:has-text('Select grades')").click()
    dlg.wait_for(state="visible")
    check(dlg.locator(".grade-row").count() == 2, "Senior popup lists the 2 grades playing this round")
    dlg.locator("button:has-text('All')").click()
    check("2 grades" in dlg.inner_text() and "4 umpire slots" in dlg.inner_text(), "All = 2 grades, 4 umpire slots (two-day games)")
    dlg.locator("button:has-text('Done')").click()
    dlg.wait_for(state="detached")
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
    page.locator("form input").first.fill("Umpire Two")
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

    browser.close()

httpd.shutdown()
print(f"\n{passed} checks passed")
real = [e for e in errors if not e.startswith("FAIL")]
if errors:
    print("\nProblems:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
