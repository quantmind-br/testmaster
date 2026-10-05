import pytest
from playwright.sync_api import expect
from playwright.async_api import expect as async_expect
import testmaster_runner as testmaster


def test_password_required(tm_page):
    with testmaster.step('password_required_sync'):
        tm_page.goto('/login')
        tm_page.get_by_role('button', name='Sign in', exact=True).click()
        expect(tm_page.get_by_test_id('password-error')).to_have_text('Password is required', timeout=4000)


@pytest.mark.asyncio
async def test_password_required_async(tm_async_page):
    with testmaster.step('password_required_async'):
        await tm_async_page.goto('/login')
        await tm_async_page.get_by_role('button', name='Sign in', exact=True).click()
        await async_expect(tm_async_page.get_by_test_id('password-error')).to_have_text('Password is required', timeout=4000)
