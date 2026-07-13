"""Web UI browser tests using Playwright.

These tests require:
- playwright and pytest-playwright installed
- Frontend built (npm run build in frontend dir)
- Server running (provided by the server_url fixture)

Skip gracefully if playwright is not available.
"""

import pytest

try:
    from playwright.sync_api import Page, expect

    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

pytestmark = [
    pytest.mark.integration,
    pytest.mark.webui,
    pytest.mark.skipif(not HAS_PLAYWRIGHT, reason="playwright not installed"),
]


@pytest.fixture
def app_page(server_url, page: "Page"):
    """Navigate to the app root and wait for it to load."""
    page.goto(server_url)
    # Wait for the sidebar to appear (indicates the app has rendered)
    page.wait_for_selector("text=deepfreeze", timeout=10000)
    return page


class TestWebUI:
    """Browser-driven tests for the deepfreeze React frontend."""

    def test_dashboard_loads(self, app_page):
        """The dashboard page renders with the app title."""
        expect(app_page.locator("h1")).to_contain_text("deepfreeze")

    def test_sidebar_navigation(self, app_page):
        """Sidebar links exist for all pages."""
        for page_name in ["Overview", "Repositories", "Thaw Requests", "Actions", "Scheduler", "Activity"]:
            locator = app_page.locator(f"text={page_name}")
            expect(locator).to_be_visible()

    def test_navigate_to_repositories(self, app_page):
        """Clicking Repositories shows the repository page."""
        app_page.click("text=Repositories")
        app_page.wait_for_url("**/repositories")
        expect(app_page.locator("h2")).to_contain_text("Repositories")

    def test_navigate_to_actions(self, app_page):
        """Clicking Actions shows the action cards."""
        app_page.click("text=Actions")
        app_page.wait_for_url("**/actions")
        expect(app_page.locator("h2")).to_contain_text("Actions")

    def test_navigate_to_activity(self, app_page):
        """Clicking Activity shows the audit log."""
        app_page.click("text=Activity")
        app_page.wait_for_url("**/activity")
        expect(app_page.locator("h2")).to_contain_text("Activity")

    def test_light_dark_toggle(self, app_page):
        """The theme toggle button exists and is clickable."""
        toggle = app_page.locator('[aria-label="Toggle light/dark mode"]')
        expect(toggle).to_be_visible()
        toggle.click()  # switch to light
        toggle.click()  # switch back to dark

    def test_config_flyout(self, app_page):
        """Clicking the gear icon opens the config flyout."""
        app_page.click('[aria-label="Configuration"]')
        expect(app_page.locator("text=Configuration")).to_be_visible()
