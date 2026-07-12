// Runs before every test file. Sets test-only values for env vars the app
// requires but that vitest.config.ts's `test.env` doesn't already own
// (DATABASE_URL/JWT_SECRET are set there, pointed at the test DB — don't
// duplicate those here). Set explicitly rather than via `dotenv/config`
// against server/.env, since that would also load the dev DATABASE_URL and
// fight with the test DB path.
process.env.FIELD_ENCRYPTION_KEY ??= "UpbcbaJpDWndbRpLuq+NyJiuCTLJj8jljgiFSQvaMVo=";
process.env.REQUIRE_HTTPS ??= "false";
process.env.WEB_ORIGIN ??= "http://localhost:5173";
process.env.SESSION_INACTIVITY_MINUTES ??= "30";
process.env.BOOTSTRAP_SECRET ??= "test-secret";
