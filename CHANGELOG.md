# Changelog

## [1.2.1](https://github.com/bardesss/arr-mcp/compare/v1.2.0...v1.2.1) (2026-08-10)


### Bug Fixes

* reclaim leaked staging dirs, and take the IMDb dataset to 81 MB ([#91](https://github.com/bardesss/arr-mcp/issues/91)) ([c0583f6](https://github.com/bardesss/arr-mcp/commit/c0583f6329379e2c8c3d52d15a6d9a4ab9cd15bd))

## [1.2.0](https://github.com/bardesss/arr-mcp/compare/v1.1.0...v1.2.0) (2026-08-10)


### Features

* make a series' IMDb rating actually reachable ([#89](https://github.com/bardesss/arr-mcp/issues/89)) ([f9fbd8f](https://github.com/bardesss/arr-mcp/commit/f9fbd8fc3860c200ffe9f84ffc12f6f25494ba84))

## [1.1.0](https://github.com/bardesss/arr-mcp/compare/v1.0.0...v1.1.0) (2026-08-08)


### Bug Fixes

* the IMDb ingest ran the process out of memory ([#83](https://github.com/bardesss/arr-mcp/issues/83)) ([f3e4a95](https://github.com/bardesss/arr-mcp/commit/f3e4a9576a2e244da647b5442c261aac66909bd3))


### Miscellaneous Chores

* cut 1.1.0 — the squash subject decided the bump ([#85](https://github.com/bardesss/arr-mcp/issues/85)) ([4e8fc69](https://github.com/bardesss/arr-mcp/commit/4e8fc69c57e7e1d3f66816a00aaf767adbe89961))

## [1.0.0](https://github.com/bardesss/arr-mcp/compare/v0.9.0...v1.0.0) (2026-08-08)


### Features

* 1.0 — the tool surface is stable ([#80](https://github.com/bardesss/arr-mcp/issues/80)) ([a469841](https://github.com/bardesss/arr-mcp/commit/a469841ea6483f2af14f60997c5e9ef94d0118a8))


### Miscellaneous Chores

* cut 1.0.0 — the squash ate the footer ([#82](https://github.com/bardesss/arr-mcp/issues/82)) ([1348c51](https://github.com/bardesss/arr-mcp/commit/1348c51186242626ef67bae91e55365d16db08a6))

## [0.9.0](https://github.com/bardesss/arr-mcp/compare/v0.8.0...v0.9.0) (2026-08-08)


### Features

* prompts and resources — the questions worth asking ([#77](https://github.com/bardesss/arr-mcp/issues/77)) ([52bdb8c](https://github.com/bardesss/arr-mcp/commit/52bdb8c06f6e5cea6a7fcecd7b61ebfc90487859))


### Documentation

* write down the two-step for cutting a verified-late phase ([#79](https://github.com/bardesss/arr-mcp/issues/79)) ([605c0e3](https://github.com/bardesss/arr-mcp/commit/605c0e37000eabccecd6bcf3bdd093a67de12fe7))

## [0.8.0](https://github.com/bardesss/arr-mcp/compare/v0.7.3...v0.8.0) (2026-08-08)


### Features

* IMDb ratings, for series too ([#74](https://github.com/bardesss/arr-mcp/issues/74)) ([eabe9ad](https://github.com/bardesss/arr-mcp/commit/eabe9ad0a47038ca42abc8a46e716fdf7245df18))


### Miscellaneous Chores

* cut 0.8 as a phase rather than a patch ([#76](https://github.com/bardesss/arr-mcp/issues/76)) ([58d0ea3](https://github.com/bardesss/arr-mcp/commit/58d0ea30c4228f7ee3db5d122035f4bc675cb2eb))

## [0.7.3](https://github.com/bardesss/arr-mcp/compare/v0.7.2...v0.7.3) (2026-08-08)


### Bug Fixes

* group disks that differ only by a service's reporting precision ([#72](https://github.com/bardesss/arr-mcp/issues/72)) ([42733d7](https://github.com/bardesss/arr-mcp/commit/42733d741ba3003ff8b8c350eda8f149d140da58))

## [0.7.2](https://github.com/bardesss/arr-mcp/compare/v0.7.1...v0.7.2) (2026-08-08)


### Features

* test before adding, and one disk row per filesystem ([#70](https://github.com/bardesss/arr-mcp/issues/70)) ([3ffe5ad](https://github.com/bardesss/arr-mcp/commit/3ffe5add4f0ab53f7b81a6e1511c7392d2595f52))

## [0.7.1](https://github.com/bardesss/arr-mcp/compare/v0.7.0...v0.7.1) (2026-08-07)


### Features

* add from a dialog, test before saving, and stop the autofill ([#68](https://github.com/bardesss/arr-mcp/issues/68)) ([89df581](https://github.com/bardesss/arr-mcp/commit/89df581ff256257efee0b5cf95c311c348f76d53))

## [0.7.0](https://github.com/bardesss/arr-mcp/compare/v0.6.3...v0.7.0) (2026-08-07)


### Features

* give every service instance its own identity ([#64](https://github.com/bardesss/arr-mcp/issues/64)) ([f829819](https://github.com/bardesss/arr-mcp/commit/f8298198bb7b4bfb52fe1f286e8fbeb023c5560b))
* let tools name which instance, and merge reads across them ([#66](https://github.com/bardesss/arr-mcp/issues/66)) ([55e65d4](https://github.com/bardesss/arr-mcp/commit/55e65d40ac42fd8d0c47f2501a236fc9ee725a46))
* rebuild the configuration page around instances ([#67](https://github.com/bardesss/arr-mcp/issues/67)) ([28f0e5f](https://github.com/bardesss/arr-mcp/commit/28f0e5f15490163d97cd1df366cc2cd696172341))

## [0.6.3](https://github.com/bardesss/arr-mcp/compare/v0.6.2...v0.6.3) (2026-08-07)


### Features

* show the MCP endpoint and a copyable client config on the dashboard ([#61](https://github.com/bardesss/arr-mcp/issues/61)) ([476cb6c](https://github.com/bardesss/arr-mcp/commit/476cb6ccf53a68ef95a40fcc101bbd5f641b20a5))

## [0.6.2](https://github.com/bardesss/arr-mcp/compare/v0.6.1...v0.6.2) (2026-08-07)


### Bug Fixes

* set up arr-mcp in the browser instead of the container log ([#59](https://github.com/bardesss/arr-mcp/issues/59)) ([d66b240](https://github.com/bardesss/arr-mcp/commit/d66b240a26a1ef323a4306550a0aeadc19a19edd))

## [0.6.1](https://github.com/bardesss/arr-mcp/compare/v0.6.0...v0.6.1) (2026-08-06)


### Bug Fixes

* close the gaps the config UI shipped with ([#56](https://github.com/bardesss/arr-mcp/issues/56)) ([8f92c30](https://github.com/bardesss/arr-mcp/commit/8f92c3029b253ebf5eae9631ba2fa35ad2a349df))

## [0.6.0](https://github.com/bardesss/arr-mcp/compare/v0.5.1...v0.6.0) (2026-08-06)


### Features

* add the config UI, with hot reload ([#54](https://github.com/bardesss/arr-mcp/issues/54)) ([0c972b9](https://github.com/bardesss/arr-mcp/commit/0c972b91e97b2f6143ec67e3d9c0f78a2e1ee21a))

## [0.5.1](https://github.com/bardesss/arr-mcp/compare/v0.5.0...v0.5.1) (2026-08-06)


### Bug Fixes

* stop add_media picking a quality profile nobody asked for ([#50](https://github.com/bardesss/arr-mcp/issues/50)) ([9e20303](https://github.com/bardesss/arr-mcp/commit/9e20303689c5bf644e54cd7577ab042d770ac130))

## [0.5.0](https://github.com/bardesss/arr-mcp/compare/v0.4.0...v0.5.0) (2026-08-06)


### Features

* add add_media, the last of Phase 4's writes ([#49](https://github.com/bardesss/arr-mcp/issues/49)) ([c7cf733](https://github.com/bardesss/arr-mcp/commit/c7cf7330d146016ca882f00dee941228e38541f5))
* add the destructive writes, and the DELETE the arrs actually answer ([#47](https://github.com/bardesss/arr-mcp/issues/47)) ([537a2a6](https://github.com/bardesss/arr-mcp/commit/537a2a6fb6ed055bf3bbcad4f9683ecff6b702ed))
* add the write foundation and trigger_search ([#45](https://github.com/bardesss/arr-mcp/issues/45)) ([260fc1f](https://github.com/bardesss/arr-mcp/commit/260fc1f2f73997cabc63daab877168cae46fb7c5))
* manage Seerr requests, and give their previews a title to show ([#48](https://github.com/bardesss/arr-mcp/issues/48)) ([3f88cd2](https://github.com/bardesss/arr-mcp/commit/3f88cd2c3d71bcbbe9f306404de05a71f9f2119d))

## [0.4.0](https://github.com/bardesss/arr-mcp/compare/v0.3.1...v0.4.0) (2026-08-06)


### Features

* add a single-flight TTL cache ([#26](https://github.com/bardesss/arr-mcp/issues/26)) ([dd683b1](https://github.com/bardesss/arr-mcp/commit/dd683b1d624d902df00d7a6bcfe70d6c9c73e9d2))
* add diagnose, the tool the project exists for ([#40](https://github.com/bardesss/arr-mcp/issues/40)) ([d61f98d](https://github.com/bardesss/arr-mcp/commit/d61f98d27e0c0d08044db383a4a8306113023cef))
* add get_library, the three-way join ([#36](https://github.com/bardesss/arr-mcp/issues/36)) ([0ad7257](https://github.com/bardesss/arr-mcp/commit/0ad725798a4e4687da40ea2663481ba3d0432057))
* add the cached library loader ([#35](https://github.com/bardesss/arr-mcp/issues/35)) ([f2883d3](https://github.com/bardesss/arr-mcp/commit/f2883d3f4ed0b7e8aed0eaf5dfdbda18b5c038b0))
* add the diagnosis chain ([#39](https://github.com/bardesss/arr-mcp/issues/39)) ([8476512](https://github.com/bardesss/arr-mcp/commit/847651255e79b14141d4d2edf26c9fde7a447b8c))
* add the identity resolver and library index ([#29](https://github.com/bardesss/arr-mcp/issues/29)) ([024c048](https://github.com/bardesss/arr-mcp/commit/024c048ff61d73700e0ce71cce8ba60723f57f5d))
* read whole libraries from Radarr, Sonarr and Jellyfin ([#34](https://github.com/bardesss/arr-mcp/issues/34)) ([f92246d](https://github.com/bardesss/arr-mcp/commit/f92246d8b1bf86c1ee4ad1a8b2a3384dabc869be))


### Bug Fixes

* capture Jellyfin search the way the adapter actually calls it ([#30](https://github.com/bardesss/arr-mcp/issues/30)) ([323e6fd](https://github.com/bardesss/arr-mcp/commit/323e6fde087c640d04227ad2981727a2eac47deb))
* close the findings from Phase 3a's whole-phase review ([#33](https://github.com/bardesss/arr-mcp/issues/33)) ([6f47a1e](https://github.com/bardesss/arr-mcp/commit/6f47a1ef7fda8220ad44508c130290e10c0bd215))
* close the findings from Phase 3b's whole-phase review ([#44](https://github.com/bardesss/arr-mcp/issues/44)) ([8450eda](https://github.com/bardesss/arr-mcp/commit/8450edadeb98b3a1b1ed9398e746fc6ee0856d60))
* let a failure tell the model what to do about it ([#38](https://github.com/bardesss/arr-mcp/issues/38)) ([4426e17](https://github.com/bardesss/arr-mcp/commit/4426e17a0e183b81cf798f41d9ec8afb2c6889b4))
* produce VersionUnsupported, which nothing could reach ([#31](https://github.com/bardesss/arr-mcp/issues/31)) ([74fb832](https://github.com/bardesss/arr-mcp/commit/74fb8321de556576063c62d34bf900e109a48bcd))
* settle §21.4 and let a Sonarr series match its Seerr request ([#41](https://github.com/bardesss/arr-mcp/issues/41)) ([caf98f7](https://github.com/bardesss/arr-mcp/commit/caf98f710791d6989419b4bf785a08f06800a45b))

## [0.3.1](https://github.com/bardesss/arr-mcp/compare/v0.3.0...v0.3.1) (2026-08-05)


### Bug Fixes

* reconcile every Phase 2b adapter against a live stack (missed 0.3.0) ([#24](https://github.com/bardesss/arr-mcp/issues/24)) ([4470e76](https://github.com/bardesss/arr-mcp/commit/4470e76e3cc3e490479a973a0404d6fc32a3e3f7))

## [0.3.0](https://github.com/bardesss/arr-mcp/compare/v0.2.1...v0.3.0) (2026-08-05)


### Features

* complete Phase 2 — the ten read tools ([#23](https://github.com/bardesss/arr-mcp/issues/23)) ([4fd103c](https://github.com/bardesss/arr-mcp/commit/4fd103c15165ef75afad7e2578139a74526f9211))
* complete Phase 2a — seven adapters, registry, stack_health across eight services ([#22](https://github.com/bardesss/arr-mcp/issues/22)) ([0b8d614](https://github.com/bardesss/arr-mcp/commit/0b8d6144623cf277184c82f3e617c2252275c71b))
* Phase 2a foundation — per-service config, ServiceHttp, capability interfaces ([#15](https://github.com/bardesss/arr-mcp/issues/15)) ([f5fefc8](https://github.com/bardesss/arr-mcp/commit/f5fefc88eb064f9321038257141dbd541aa8cccb))
* Phase 2b core modules — fencing, gathering, identity, budgets ([#17](https://github.com/bardesss/arr-mcp/issues/17)) ([00928d0](https://github.com/bardesss/arr-mcp/commit/00928d061f957e07b4393049df14e5290cf44009))
* vendor OpenAPI specs, codegen, and fixture capture with a secret guard ([#16](https://github.com/bardesss/arr-mcp/issues/16)) ([f3c6e50](https://github.com/bardesss/arr-mcp/commit/f3c6e501625e68a451ccd12e9ed36667d0eb55e8))


### Bug Fixes

* classify the connect failures a wrong LAN address actually produces ([#20](https://github.com/bardesss/arr-mcp/issues/20)) ([13d1306](https://github.com/bardesss/arr-mcp/commit/13d1306953da7ce9efd41f3ca4fa74bdcca98ddb))
* remove the byte order mark that broke release-please ([#19](https://github.com/bardesss/arr-mcp/issues/19)) ([36eb5bb](https://github.com/bardesss/arr-mcp/commit/36eb5bbabcab66ed7a4539cc1d9e4dfe8d2a5aad))

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
