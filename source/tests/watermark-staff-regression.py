"""A pale watermark must not make a full score page collapse to a few rows."""

from pathlib import Path

from playwright.sync_api import sync_playwright


source = Path(__file__).resolve().parents[1]
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        headless=True,
    )
    page = browser.new_page()
    page.add_script_tag(path=str(source / "core-engine.js"))
    page.add_script_tag(path=str(source / "core-v04.js"))
    result = page.evaluate("""() => {
      const canvas = document.createElement('canvas');
      canvas.width = 783;
      canvas.height = 480;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (const top of [80, 170, 260, 350]) {
        context.fillStyle = '#c9c9c9';
        for (let line = 0; line < 5; line += 1) {
          context.fillRect(24, top + line * 7, 730, 1);
        }
        context.fillStyle = '#111';
        for (let note = 0; note < 12; note += 1) {
          const x = 55 + note * 55;
          context.fillRect(x, top + 12, 7, 5);
          context.fillRect(x + 6, top - 4, 2, 18);
        }
      }
      context.fillStyle = 'rgba(200, 60, 75, 0.25)';
      context.fillRect(250, 115, 290, 300);
      return DrumScopeCore.extractStaffRows(canvas, {
        mode: 'auto', removeColorArtifacts: true,
      }).map(row => Math.round(row.sourceStaffTop));
    }""")
    scrolling = page.evaluate("""() => {
      const master = document.createElement('canvas');
      master.width = 783;
      master.height = 1000;
      const context = master.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, master.width, master.height);
      for (let index = 0; index < 8; index += 1) {
        const top = 80 + index * 105;
        context.fillStyle = '#c9c9c9';
        for (let line = 0; line < 5; line += 1) {
          context.fillRect(24, top + line * 7, 730, 1);
        }
        context.fillStyle = '#111';
        context.font = 'bold 19px serif';
        context.fillText(String(index * 4 + 1), 38, top - 7);
        for (let note = 0; note < 12; note += 1) {
          const x = 55 + note * 55 + (index * 7 + note * 3) % 13;
          context.fillRect(x, top + 12 - (note * 11 + index * 17) % 5 * 3, 7, 5);
          context.fillRect(x + 6, top - 4, 2, 18);
          if ((note + index * 3) % 4 === 0) context.fillRect(x, top - 4, 30, 3);
        }
      }
      const groups = [0, 180, 90, 260, 430].map((offset, sequenceIndex) => {
        const frame = document.createElement('canvas');
        frame.width = 783;
        frame.height = 480;
        const image = frame.getContext('2d');
        image.drawImage(master, 0, offset, 783, 480, 0, 0, 783, 480);
        image.fillStyle = 'rgba(200, 60, 75, 0.25)';
        image.fillRect(250, 115, 290, 300);
        const rows = DrumScopeCore.extractStaffRows(frame, { mode: 'auto' });
        return { rows: rows.map(row => ({ ...row, sequenceIndex })) };
      });
      const merged = DrumScopeCore.mergeScrollingSequences(groups);
      return { rows: merged?.rows.length, offsets: merged?.scrollOffsets };
    }""")
    browser.close()

assert len(result) == 4, result
assert all(abs(actual - expected) <= 3 for actual, expected in zip(result, [80, 170, 260, 350])), result
assert scrolling["rows"] and 6 <= scrolling["rows"] <= 8, scrolling
assert any(right < left for left, right in zip(scrolling["offsets"], scrolling["offsets"][1:])), scrolling
print("watermark staff regression passed")
