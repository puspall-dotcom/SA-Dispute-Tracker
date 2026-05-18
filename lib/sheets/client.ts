import { google, type sheets_v4 } from "googleapis";
import { OAuth2Client } from "google-auth-library";

declare global {
  // eslint-disable-next-line no-var
  var __sheetsClient: sheets_v4.Sheets | undefined;
}

function getOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google Sheets credentials missing in env");
  }
  const oauth = new google.auth.OAuth2(clientId, clientSecret);
  oauth.setCredentials({ refresh_token: refreshToken });
  return oauth;
}

export function sheetsClient(): sheets_v4.Sheets {
  if (!globalThis.__sheetsClient) {
    globalThis.__sheetsClient = google.sheets({
      version: "v4",
      auth: getOAuthClient(),
    });
  }
  return globalThis.__sheetsClient;
}

export async function readRange(spreadsheetId: string, range: string): Promise<string[][]> {
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const values = (res.data.values || []) as unknown[][];
  return values.map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c))));
}
