import { expect, test, type Page, type Route } from '@playwright/test';

const baseUrl = process.env.MANAGE_TEST_URL || 'http://localhost:5173';

const users = {
  USER: { id: 'user-1', email: 'user@iiitnr.edu.in', displayName: 'Student User', role: 'USER' },
  ADMIN: { id: 'admin-1', email: 'admin@iiitnr.edu.in', displayName: 'Admin User', role: 'ADMIN' },
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockAuth(page: Page, user: typeof users.USER | typeof users.ADMIN | null) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/auth/me') return json(route, { user });
    if (url.pathname === '/api/v1/auth/csrf') return json(route, { csrfToken: 'test-csrf-token' });
    if (url.pathname === '/api/v1/public/events') return json(route, { items: [], total: 0, page: 1, pageSize: 5, totalPages: 0 });
    return json(route, { items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 });
  });
}

test.describe('management auth and role boundaries', () => {
  test('keeps recovery signed-out capable and verifies only after an explicit click', async ({ page }) => {
    let forgotEmail = '';
    let verifyRequests = 0;
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/auth/me') return json(route, { user: null });
      if (url.pathname === '/api/v1/auth/forgot-password') {
        forgotEmail = (request.postDataJSON() as { email: string }).email;
        return json(route, { message: 'If the address is eligible, a reset link has been sent.' });
      }
      if (url.pathname === '/api/v1/auth/verify') {
        verifyRequests += 1;
        return route.fulfill({ status: 302, headers: { location: '/manage/login?verified=1' }, body: '' });
      }
      return json(route, { items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 });
    });

    await page.goto(`${baseUrl}/manage/login`);
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await page.getByLabel('Institutional email').fill('recover@iiitnr.edu.in');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If the address is eligible, a reset link has been sent.')).toBeVisible();
    expect(forgotEmail).toBe('recover@iiitnr.edu.in');

    await page.goto(`${baseUrl}/manage/verify-email`);
    await expect(page.locator('.notice-danger')).toContainText('This verification link is missing its token.');
    await expect(page.getByRole('button', { name: 'Verify email' })).toBeDisabled();

    await page.goto(`${baseUrl}/manage/verify-email?token=verify-token`);
    await expect(page.getByRole('button', { name: 'Verify email' })).toBeVisible();
    expect(verifyRequests).toBe(0);
    await page.getByRole('button', { name: 'Verify email' }).click();
    await expect(page).toHaveURL(/\/manage\/login\?verified=1$/);
    expect(verifyRequests).toBe(1);
  });

  test('keeps participant management inside the admin shell and exposes its event link', async ({ page }) => {
    let participantRequests = 0;
    await mockAuth(page, users.USER);
    await page.route('**/api/v1/admin/events/evt-1/participants*', async (route) => {
      participantRequests += 1;
      return json(route, { items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 });
    });
    await page.goto(`${baseUrl}/manage/admin/events/evt-1/participants`);
    await expect(page).toHaveURL(/\/manage\/?$/);
    expect(participantRequests).toBe(0);

    await page.unroute('**/api/v1/**');
    await mockAuth(page, users.ADMIN);
    await page.route('**/api/v1/admin/events?pageSize=100', async (route) => json(route, {
      items: [{ id: 'evt-1', title: 'Campus Cleanup', category: 'Service', venue: 'Quad', status: 'DRAFT', startAt: '2026-10-20T10:00:00.000Z' }],
      total: 1,
    }));
    await page.route('**/api/v1/admin/events/evt-1/participants*', async (route) => json(route, { items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 }));
    await page.goto(`${baseUrl}/manage/admin/events`);
    await expect(page.getByRole('link', { name: 'Participants' })).toBeVisible();
    await page.getByRole('link', { name: 'Participants' }).click();
    await expect(page.getByRole('heading', { name: 'Campus Cleanup' })).toBeVisible();
    await expect(page.getByText('Bulk import')).toBeVisible();
  });
});

test('imports quoted participant CSV, reads it back for editing, and paginates the endpoint total', async ({ page }) => {
  const existing = { id: 'participant-1', name: 'Existing student', rollNo: 'E-1', role: 'Volunteer', department: 'NSS', batch: '2025', contribution: '', attendance: 'present' };
  const imported = { id: 'participant-2', name: 'Doe, "Ada"', rollNo: 'R-1', role: 'Lead', department: 'Computer Science, AI', batch: '2026', contribution: 'Welcomed\nnew cohort', attendance: 'present' };
  let items = [existing];
  let total = 21;
  let importedPayload: unknown;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/auth/me') return json(route, { user: users.ADMIN });
    if (url.pathname === '/api/v1/admin/events' && request.method() === 'GET') return json(route, { items: [{ id: 'evt-1', title: 'Campus Cleanup' }], total: 1 });
    if (url.pathname === '/api/v1/admin/events/evt-1/participants' && request.method() === 'GET') {
      const requestedPage = Number(url.searchParams.get('page') || '1');
      return json(route, { items: requestedPage === 2 ? [{ ...imported, id: 'participant-page-2', name: 'Page two participant' }] : items, page: requestedPage, pageSize: 20, total, totalPages: 2 });
    }
    if (url.pathname === '/api/v1/admin/events/evt-1/participants/import') {
      importedPayload = request.postDataJSON();
      items = [...items, imported];
      total += 1;
      return json(route, { items: [imported], count: 1 }, 201);
    }
    if (url.pathname === '/api/v1/admin/events/evt-1/participants/participant-2' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as { department: string };
      items = items.map((item) => item.id === 'participant-2' ? { ...item, ...body } : item);
      return json(route, { item: items.find((item) => item.id === 'participant-2') });
    }
    return json(route, { items: [], total: 0, page: 1, pageSize: 24, totalPages: 0 });
  });

  await page.goto(`${baseUrl}/manage/admin/events/evt-1/participants`);
  await expect(page.getByText('Existing student')).toBeVisible();
  const csv = 'Name,Roll No,Role,Department,Batch,Contribution,Attendance\n"Doe, ""Ada""",R-1,Lead,"Computer Science, AI",2026,"Welcomed\nnew cohort",present';
  await page.getByRole('textbox').last().fill(csv);
  await page.getByRole('button', { name: 'Import rows' }).click();
  await expect(page.getByText('Doe, "Ada"')).toBeVisible();
  expect((importedPayload as { rows: Array<typeof imported> }).rows[0]).toMatchObject({ name: imported.name, rollNo: imported.rollNo, role: imported.role, department: imported.department, batch: imported.batch, contribution: imported.contribution, attendance: imported.attendance });

  await page.getByRole('button', { name: 'Edit' }).last().click();
  await expect(page.getByLabel('Name')).toHaveValue('Doe, "Ada"');
  await expect(page.getByLabel('Contribution')).toHaveValue('Welcomed\nnew cohort');
  await page.getByLabel('Department').fill('Computer Science, AI & Data');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Computer Science, AI & Data')).toBeVisible();

  await expect(page.getByText('Page 1 of 2 · 22 total')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Page two participant')).toBeVisible();
  await expect(page.getByText('Page 2 of 2 · 22 total')).toBeVisible();
});
