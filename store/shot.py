import time, os
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "file://" + BASE + "/www/index.html"

SIZES = {
    "6.9inch": {"css": (440, 956), "scale": 3, "target": (1320, 2868)},
    "6.5inch": {"css": (414, 896), "scale": 3, "target": (1242, 2688)},
}

TEAMS = [
    ("レッド", "red", ["ハルト", "ソウタ", "ユウキ", "ミオ", "サクラ", "アオイ"]),
    ("ブルー", "blue", ["カイト", "レン", "ダイキ", "ヒナ", "ユイ", "リン"]),
    ("グリーン", "green", ["ショウ", "ツバサ", "リョウ", "ミサキ", "エマ", "ノア"]),
    ("イエロー", "yellow", ["タイガ", "ジン", "コウキ", "モモカ", "コトネ", "アカリ"]),
]


def fill_onboard(page):
    # Step1: names + colors already default colors match order; just set names
    # NOTE: mini-num-input (match/break minutes) is also type=text, so scope to .team-block only
    inputs = page.locator("#onboardBody .team-block input[type=text]")
    n = inputs.count()
    names = ["レッド", "ブルー", "イエロー", "グリーン"]
    for i in range(min(4, n)):
        inputs.nth(i).fill(names[i])
    page.click("#btnOnboardNext")
    page.wait_for_timeout(200)
    # Step2: members
    team_inputs = page.locator("#onboardBody .team-block input[type=text]")
    members_by_team = [
        ["ハルト", "ソウタ", "ユウキ", "ミオ", "サクラ", "アオイ"],
        ["カイト", "レン", "ダイキ", "ヒナ", "ユイ", "リン"],
        ["タイガ", "ジン", "コウキ", "モモカ", "コトネ", "アカリ"],
        ["ショウ", "ツバサ", "リョウ", "ミサキ", "エマ", "ノア"],
    ]
    idx = 0
    flat = [name for team in members_by_team for name in team]
    total = team_inputs.count()
    for i in range(min(total, len(flat))):
        team_inputs.nth(i).fill(flat[i])
    page.wait_for_timeout(200)
    page.click("#btnOnboardNext")
    page.wait_for_timeout(200)
    page.click("#btnOnboardNext")  # start tournament
    page.wait_for_timeout(300)


def resize_to(path, target_w, target_h):
    from PIL import Image
    img = Image.open(path)
    if img.size != (target_w, target_h):
        img = img.resize((target_w, target_h), Image.LANCZOS)
        img.save(path)


def capture_for_size(p, label, cfg):
    css_w, css_h = cfg["css"]
    scale = cfg["scale"]
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": css_w, "height": css_h}, device_scale_factor=scale)
    page.goto(URL)
    page.wait_for_timeout(300)

    outdir = os.path.join(BASE, "store", "screenshots", label)
    os.makedirs(outdir, exist_ok=True)

    fill_onboard(page)

    # 01: onboarding wizard - go back to step to show it, but tournament already started.
    # Instead reload and capture step1 screen fresh in a new page for the wizard shot.
    page2 = browser.new_page(viewport={"width": css_w, "height": css_h}, device_scale_factor=scale)
    page2.goto(URL)
    page2.wait_for_timeout(300)
    inputs = page2.locator("#onboardBody .team-block input[type=text]")
    names = ["レッド", "ブルー", "イエロー", "グリーン"]
    for i in range(min(4, inputs.count())):
        inputs.nth(i).fill(names[i])
    page2.evaluate("window.scrollTo(0,0)")
    page2.wait_for_timeout(200)
    p1 = os.path.join(outdir, "01.png")
    page2.screenshot(path=p1)
    resize_to(p1, *cfg["target"])
    page2.close()

    # Now on matches list. Click first match to enter live scoring.
    page.click("#screen-matches .match-card >> nth=0")
    page.wait_for_timeout(300)
    # tap some scores to make it look lively
    home_btns = page.locator("#homeMembers .member-btn")
    away_btns = page.locator("#awayMembers .member-btn")
    for i in [0, 1, 0, 2]:
        if home_btns.count() > i:
            home_btns.nth(i).click()
            page.wait_for_timeout(80)
    for i in [1, 0]:
        if away_btns.count() > i:
            away_btns.nth(i).click()
            page.wait_for_timeout(80)
    page.wait_for_timeout(200)
    p2 = os.path.join(outdir, "02.png")
    page.screenshot(path=p2)
    resize_to(p2, *cfg["target"])

    # finish this match and a few more to populate standings
    page.click("#btnFinish")
    page.wait_for_timeout(150)
    page.click("#btnFinishConfirm")
    page.wait_for_timeout(200)
    # play through remaining matches quickly to get standings populated
    for _ in range(11):
        next_btn = page.locator("#btnNextMatch")
        if next_btn.count() > 0 and next_btn.is_visible():
            next_btn.click()
            page.wait_for_timeout(150)
            hb = page.locator("#homeMembers .member-btn")
            ab = page.locator("#awayMembers .member-btn")
            if hb.count() > 0:
                hb.nth(0).click()
                page.wait_for_timeout(50)
            if ab.count() > 0:
                ab.nth(0).click()
                page.wait_for_timeout(50)
                ab.nth(0).click()
                page.wait_for_timeout(50)
            page.click("#btnFinish")
            page.wait_for_timeout(120)
            page.click("#btnFinishConfirm")
            page.wait_for_timeout(150)
        else:
            break

    # 03: standings/rank screen
    page.click('nav button[data-screen="rank"]')
    page.wait_for_timeout(300)
    p3 = os.path.join(outdir, "03.png")
    page.screenshot(path=p3)
    resize_to(p3, *cfg["target"])

    # 04: finale screen - by this point all 12 matches are already "done" (finished above).
    # Reopen the last match, "re-open" it (btnFinish becomes 再開), then finish it again so
    # findNextPendingIndex() returns null and the "🏆 表彰式を見る" (btnGoFinale) button appears.
    page.click('nav button[data-screen="matches"]')
    page.wait_for_timeout(200)
    cards = page.locator("#matchesList .match-card")
    total_cards = cards.count()
    if total_cards > 0:
        cards.nth(total_cards - 1).click()
        page.wait_for_timeout(200)
        page.click("#btnFinish")  # status done -> becomes ongoing (再開)
        page.wait_for_timeout(150)
        page.click("#btnFinish")  # ongoing -> show finish confirm panel
        page.wait_for_timeout(150)
        page.click("#btnFinishConfirm")
        page.wait_for_timeout(250)
        gofinale = page.locator("#btnGoFinale")
        if gofinale.count() > 0:
            gofinale.click()
            page.wait_for_timeout(300)

    p4 = os.path.join(outdir, "04.png")
    page.screenshot(path=p4)
    resize_to(p4, *cfg["target"])

    # 05: matches list overview (final state, all done badges)
    page.click('nav button[data-screen="matches"]')
    page.wait_for_timeout(300)
    p5 = os.path.join(outdir, "05.png")
    page.screenshot(path=p5)
    resize_to(p5, *cfg["target"])

    browser.close()


with sync_playwright() as p:
    for label, cfg in SIZES.items():
        capture_for_size(p, label, cfg)
        print("done", label)
