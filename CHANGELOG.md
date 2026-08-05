# Changelog

## [0.2.1](https://github.com/bardesss/arr-mcp/compare/v0.2.0...v0.2.1) (2026-08-05)


### Bug Fixes

* drop privileges by numeric id so PUID/PGID cannot silently fail ([#12](https://github.com/bardesss/arr-mcp/issues/12)) ([8060362](https://github.com/bardesss/arr-mcp/commit/8060362d2a261ba74d63e074c0f85636b33d8638))

## [0.2.0](https://github.com/bardesss/arr-mcp/compare/v0.1.0...v0.2.0) (2026-08-04)


### Features

* add error taxonomy and response shaping contract ([#3](https://github.com/bardesss/arr-mcp/issues/3)) ([29c03dd](https://github.com/bardesss/arr-mcp/commit/29c03dd48df88cf37b4d16a92649c64bd4441010))
* add multi-stage non-root container with PUID/PGID and healthcheck ([#6](https://github.com/bardesss/arr-mcp/issues/6)) ([262767e](https://github.com/bardesss/arr-mcp/commit/262767e9afc569acc7aa850e4ffc2f8412f666a1))
* add Radarr adapter with diagnosing connection test and circuit breaker ([#4](https://github.com/bardesss/arr-mcp/issues/4)) ([513a038](https://github.com/bardesss/arr-mcp/commit/513a03869bc0be72b56e11f005eb1f18f2438486))
* config schema and loader ([#2](https://github.com/bardesss/arr-mcp/issues/2)) ([3845ddd](https://github.com/bardesss/arr-mcp/commit/3845ddd1491cf4a65f945cb9bc8c8c57cfb77233))
* serve stateless MCP at /mcp behind required bearer auth ([#5](https://github.com/bardesss/arr-mcp/issues/5)) ([2c24e83](https://github.com/bardesss/arr-mcp/commit/2c24e83f0fd18c515b9d3151a6a0f3072e721957))


### Bug Fixes

* pin the first release to 0.1.0 rather than 1.0.0 ([#9](https://github.com/bardesss/arr-mcp/issues/9)) ([bf4f351](https://github.com/bardesss/arr-mcp/commit/bf4f351aad946e053b78381a7965ce7d87645cf9))
* publish version image tags, not just latest ([#10](https://github.com/bardesss/arr-mcp/issues/10)) ([350ef4b](https://github.com/bardesss/arr-mcp/commit/350ef4b4cacc46fd5ffab97075cff0977ec6f0d9))

## 0.1.0 (2026-08-04)


### Features

* add error taxonomy and response shaping contract ([#3](https://github.com/bardesss/arr-mcp/issues/3)) ([29c03dd](https://github.com/bardesss/arr-mcp/commit/29c03dd48df88cf37b4d16a92649c64bd4441010))
* add multi-stage non-root container with PUID/PGID and healthcheck ([#6](https://github.com/bardesss/arr-mcp/issues/6)) ([262767e](https://github.com/bardesss/arr-mcp/commit/262767e9afc569acc7aa850e4ffc2f8412f666a1))
* add Radarr adapter with diagnosing connection test and circuit breaker ([#4](https://github.com/bardesss/arr-mcp/issues/4)) ([513a038](https://github.com/bardesss/arr-mcp/commit/513a03869bc0be72b56e11f005eb1f18f2438486))
* config schema and loader ([#2](https://github.com/bardesss/arr-mcp/issues/2)) ([3845ddd](https://github.com/bardesss/arr-mcp/commit/3845ddd1491cf4a65f945cb9bc8c8c57cfb77233))
* serve stateless MCP at /mcp behind required bearer auth ([#5](https://github.com/bardesss/arr-mcp/issues/5)) ([2c24e83](https://github.com/bardesss/arr-mcp/commit/2c24e83f0fd18c515b9d3151a6a0f3072e721957))


### Bug Fixes

* pin the first release to 0.1.0 rather than 1.0.0 ([#9](https://github.com/bardesss/arr-mcp/issues/9)) ([bf4f351](https://github.com/bardesss/arr-mcp/commit/bf4f351aad946e053b78381a7965ce7d87645cf9))
