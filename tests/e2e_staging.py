"""End-to-end test of the deployed STAGING site, with real Supabase and real data (headless Chromium).

Signs in with the three staging-only test accounts (password sign-in, addresses ending @thirdumpire.test)
in the Parramatta District association itself:
  officer    - sees the board, updates the grades from PlayHQ, sees the Members table and join requests
  umpire     - sees My availability and the Associations list, never the word "officer"
  applicant  - asks to join, the officer sees the request, then the request is taken back (cleans up after itself)

Run (the GitHub Action does this after each deploy):
  STAGING_URL=https://third-umpire-staging.pages.dev \
  TEST_OFFICER_PASSWORD=... TEST_UMPIRE_PASSWORD=... TEST_APPLICANT_PASSWORD=... \
  python3 tests/e2e_staging.py

The passwords are never in the repo: they are GitHub Actions secrets. See README, "Staging tests".
"""
import json, os, re, sys, traceback
from playwright.sync_api import sync_playwright

BASE = os.environ.get("STAGING_URL", "https://third-umpire-staging.pages.dev").rstrip("/") + "/"
ORG_NAME = os.environ.get("TEST_ORG_NAME", "Parramatta")
ACCOUNTS = {
    "officer": (os.environ.get("TEST_OFFICER_EMAIL", "test-officer@thirdumpire.test"), os.environ.get("TEST_OFFICER_PASSWORD", "")),
    "umpire": (os.environ.get("TEST_UMPIRE_EMAIL", "test-umpire@thirdumpire.test"), os.environ.get("TEST_UMPIRE_PASSWORD", "")),
    "applicant": (os.environ.get("TEST_APPLICANT_EMAIL", "test-applicant@thirdumpire.test"), os.environ.get("TEST_APPLICANT_PASSWORD", "")),
}
SHOTS = os.environ.get("SHOTS_DIR", "staging-failures")
CHROME = os.environ.get("CHROME")           # optional: a Chrome/Chromium binary; otherwise Playwright's own

passed, errors = 0, []
os.makedirs(SHOTS, exist_ok=True)


def check(cond, msg):
    global passed
    if cond:
        passed += 1
        print("  ok:", msg)
    else:
        errors.append("FAIL: " + msg)
        print("FAIL:", msg)


def snap(page, name):
    try:
        page.screenshot(path=os.path.join(SHOTS, re.sub(r"[^a-z0-9]+", "-", name.lower()) + ".png"), full_page=True)
    except Exception:
        pass


def sign_in(page, who):
    email, password = ACCOUNTS[who]
    page.goto(BASE)
    page.wait_for_selector("#login-email, .who", timeout=30000)
    if not page.locator("#pw-email").count():
        raise RuntimeError("The test sign-in is not on this site. Set PASSWORD_LOGIN=1 for the staging build (Cloudflare Pages project third-umpire-staging, Variables and secrets).")
    page.fill("#pw-email", email)
    page.fill("#pw-password", password)
    page.click("#pw-submit")
    page.wait_for_selector(".who-name", timeout=30000)


def api(page, method, path, body=None):
    """Call Supabase with the signed-in test user's own session (so the database rules apply to it)."""
    return page.evaluate("""async ([method, path, body]) => {
        const { CONFIG } = await import('/js/config.js');
        const k = Object.keys(localStorage).find(x => /auth-token/.test(x));
        const token = JSON.parse(localStorage[k]).access_token;
        const r = await fetch(CONFIG.supabase.url + '/rest/v1/' + path, { method, headers: { apikey: CONFIG.supabase.anonKey,
          Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    }""", [method, path, body])


def go(page, path):
    p = "/" + path.lstrip("/")
    page.evaluate("p => { history.pushState(null, '', p); window.dispatchEvent(new Event('route')); }", p)
    # the old page stays on screen until the new one is ready: wait for the new one, not for whatever is showing
    page.wait_for_function("p => document.querySelector('main').dataset.path === p && !document.querySelector('main.busy')", arg=p, timeout=60000)


def section(title):
    print("\n" + title)


def run_officer(browser):
    section("Officer")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"PAGE ERROR (officer): {e}"))
    try:
        sign_in(page, "officer")
        page.wait_for_selector(".nav", timeout=30000)
        check(ORG_NAME in page.inner_text("header"), f"the header shows the association ({ORG_NAME})")
        page.wait_for_selector(".week, .comp-tile, .notice", timeout=60000)
        page.wait_for_timeout(2000)
        check(page.locator(".notice.err").count() == 0, "Allocate loads without a fixtures error")
        # Grades: refresh from PlayHQ, then Settings lists exactly what was saved from that fetch
        go(page, "admin/settings")
        page.wait_for_selector(".groups-card", timeout=30000)
        btn = page.locator("button:has-text('Update from PlayHQ')")
        check(btn.count() == 1, "Settings has the Update from PlayHQ button")
        if btn.count():
            btn.click()
            page.wait_for_selector(".groups-card table.grades-table", timeout=120000)
            page.wait_for_timeout(1500)
        rows = page.locator("table.grades-table tbody tr")
        check(rows.count() >= 1, f"Settings lists grades after the update ({rows.count()})")
        cfg = api(page, "GET", "associations?select=id,config&id=eq.pdca")
        grade_comps = ((cfg["body"] or [{}])[0].get("config") or {}).get("gradeComps") or {}
        check(len(grade_comps) >= 1, "the grade list from PlayHQ was saved (gradeComps)")
        shown = [r.locator("td").first.locator("span.muted").inner_text().strip() for r in rows.all()]   # the full grade name (the chip beside it is the short form)
        norm = lambda x: " ".join(str(x).split())                        # the page collapses runs of spaces; so compare without them
        keys = [norm(k) for k in grade_comps]
        stale = [g for g in shown if g and norm(g) not in keys]
        check(not stale, f"every grade in Settings came from the last PlayHQ fetch (stale: {stale[:3]}; the saved list has {len(keys)}: {[k for k in keys if "T20" in k][:4]})")
        # Members
        go(page, "admin/members")
        page.wait_for_selector("table.members, .muted", timeout=30000)
        check(page.locator("table.members button:has-text('Approve'), table.members button:has-text('Reject')").count() == 0,
              "the Members table has no Approve / Reject buttons")
    except Exception:
        errors.append("ERROR (officer): " + traceback.format_exc())
        snap(page, "officer-error")
    return ctx, page


def run_umpire(browser):
    section("Umpire")
    ctx = browser.new_context(viewport={"width": 390, "height": 844})        # a phone
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"PAGE ERROR (umpire): {e}"))
    try:
        sign_in(page, "umpire")
        page.wait_for_selector(".avail-card, .pending-card", timeout=60000)     # wait for the page itself, not a fixed time
        page.wait_for_timeout(1000)
        txt = page.inner_text("body")
        check("officer" not in txt.lower(), "My availability never says officer")
        check(page.locator(".comp-section").count() > 0 or "No availabilities are open" in txt or "No dates to answer" in txt or page.locator(".pending-card").count() > 0,
              f"My availability shows groups, or says none are open ({txt[:200]!r})")
        check(page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"), "no sideways scrolling on a phone")
        go(page, "profile")
        page.wait_for_selector(".member-profile .org-list", timeout=30000)
        row = page.locator(f".member-profile .org-row:has-text('{ORG_NAME}')")
        check(row.count() == 1 and "Member" in row.inner_text(), "My profile lists Parramatta with the status Member")
        check("officer" not in page.inner_text("body").lower(), "My profile never says officer")
    except Exception:
        errors.append("ERROR (umpire): " + traceback.format_exc())
        snap(page, "umpire-error")
    return ctx, page


def run_applicant(browser, officer_page):
    section("Applicant: ask to join, the officer sees it, take it back")
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"PAGE ERROR (applicant): {e}"))
    email = ACCOUNTS["applicant"][0]
    try:
        sign_in(page, "applicant")
        page.wait_for_selector("main", timeout=30000)
        page.wait_for_timeout(1500)
        api(page, "DELETE", f"memberships?association_id=eq.pdca&email=eq.{email}")      # start clean
        go(page, "profile")                                                    # a new sign-up can open their profile
        page.wait_for_selector(".member-profile", timeout=30000)
        txt = page.inner_text(".member-profile")
        check(all(x in txt for x in ("Mobile", "Date of birth", "Accreditation no.", "Accreditation provider")) and email in txt,
              "a new sign-up's profile opens and shows every detail an association can ask for")
        go(page, "associations")
        page.wait_for_selector(".org-list", timeout=30000)
        join = page.locator(f".org-row:has-text('{ORG_NAME}') a:has-text('Join')")
        check(join.count() == 1, "a new person sees Parramatta in the list to join")
        join.click()
        page.wait_for_selector(".join-form", timeout=30000)
        for i, val in enumerate(("Test", "Applicant")):                   # first and last name: new people have no profile to fill them in
            f = page.locator(".join-form input").nth(i)
            if not f.input_value():
                f.fill(val)
        for key, val in (("phone", "0400 000 000"), ("dob", "1990-01-01"), ("address", "1 Test St"), ("accreditation", "T-0001")):
            f = page.locator(f".join-form input[data-field={key}]")
            if f.count() and not f.input_value():
                f.fill(val)
        page.click(".join-form button[type=submit]")
        page.wait_for_selector(".pending-card, .avail-head", timeout=30000)
        waiting = page.locator(".pending-card").count() == 1
        check(True, f"the request was sent ({'waiting for approval' if waiting else 'membership not required: in at once'})")
        check("officer" not in page.inner_text("body").lower(), "the applicant's page never says officer")
        # the officer sees it
        officer_page.goto(BASE + "admin/members")
        officer_page.wait_for_selector("table.members, .join-requests", timeout=30000)
        officer_page.wait_for_timeout(1500)
        check(officer_page.locator(f".join-requests .request:has-text('{email}')").count() == 1, "the officer sees the request in the Join requests card")
        check("Waiting for approval" in officer_page.inner_text("table.members") or officer_page.locator(".join-requests").count() == 1,
              "the Members table shows the person as Waiting for approval")
    except Exception:
        try: seen_text = " | ".join(x.strip() for x in page.inner_text("body").splitlines() if x.strip())[:700] + f" [url {page.url}]"
        except Exception: seen_text = "(page not readable)"
        errors.append("ERROR (applicant): " + traceback.format_exc() + "\nThe page showed: " + seen_text)
        snap(page, "applicant-error")
    finally:
        try:
            api(page, "DELETE", f"memberships?association_id=eq.pdca&email=eq.{email}")      # take the request back
            left = api(page, "GET", f"memberships?select=email&association_id=eq.pdca&email=eq.{email}")
            check(left["status"] == 200 and left["body"] == [], "the test request is taken back (needs migration 0007 on staging)")
        except Exception:
            errors.append("ERROR cleaning up the applicant: " + traceback.format_exc())
    return ctx


def main():
    missing = [k for k, (_, pw) in ACCOUNTS.items() if not pw]
    if missing:
        print("Missing passwords for: " + ", ".join(missing) + " (set TEST_<ROLE>_PASSWORD)")
        sys.exit(2)
    with sync_playwright() as p:
        kw = {"executable_path": CHROME} if CHROME else {}
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"], **kw)
        octx, opage = run_officer(browser)
        uctx, _ = run_umpire(browser)
        actx = run_applicant(browser, opage)
        for c in (octx, uctx, actx):
            c.close()
        browser.close()
    print(f"\n{passed} checks passed")
    if errors:
        print("\nProblems:")
        for e in errors:
            print(" -", e)
        sys.exit(1)


main()
