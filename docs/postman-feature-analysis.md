# Analisis Fitur Postman untuk API Documentation

## Target dan metode

Analisis dilakukan pada paket desktop Postman 12.31.3 di
`/home/respati/Applications/Postman/app/resources/app` menggunakan REA 6.4.0.
Artefak memiliki SHA-256
`e9c4e6d4f77e8cc633998bdf0bb854e2795da24af42f2a79c88bcece1bf33a86`.
Evidence utama: `ev_ffed3d51f7024f0fe6a14e03f812f294a4277a8eae1e3ca6348df685f7ddac33`.

REA membaca 441 berkas relevan, mem-parsing 394 berkas JavaScript, dan menemukan
3.745 modul. Analisis ini bersifat statis; keberadaan modul membuktikan bahwa
fitur dikirim bersama aplikasi, tetapi tidak membuktikan seluruh perilaku UI atau
layanan cloud saat runtime.

## Fitur yang teramati

| Area | Bukti dalam artefak | Kemampuan produk yang dapat diturunkan |
| --- | --- | --- |
| Organisasi | `CollectionSidebar.js`, `EnvironmentSidebar.js`, `HistorySidebarController.js` | Collection/folder, environment variables, dan riwayat request |
| Request HTTP | `postman-runtime.js`, `postman-request`, `postman-collection` | Method, URL, params, headers, body, auth, cookies, dan response viewer |
| Protokol lain | `ECWebsocketWorkbench.js`, GraphQL worker, gRPC client/reflection, MQTT client | WebSocket, GraphQL, gRPC, dan MQTT |
| Import | `openapi-to-postmanv2.js`, `graphql-to-postman.js`, `curl-to-postmanv2.js`, `har-to-postman.js`, converter RAML/WSDL | Impor spesifikasi dan request dari format umum |
| Otomasi | `html/runner.html`, `html/tester_sandbox.html`, `js/tester/Evaluator.js` | Collection runner, script sebelum/sesudah request, dan assertion |
| Dokumentasi | `DocumentationContextBar*`, `postman-code-generators.js` | Deskripsi request dan contoh kode klien |
| Simulasi | `mock-server-runtime/http-server-worker.js` | Mock server berbasis contoh response |
| Visualisasi | `visualizer_view_preload.js`, `js/visualizer/vendor.min.js` | Tampilan response yang dapat dikustomisasi |
| Kinerja | `perftest.js`, `perftestExecute.js` | Menjalankan skenario performance test |
| Autentikasi | `services_OAuth2WindowManager*.js` | Alur OAuth 2 selain auth dasar pada request |

Node REA yang mewakili bukti utama antara lain
`jag_node_3f4daef8...` (collections), `jag_node_e1327d04...`
(environments), `jag_node_30aa39a7...` (WebSocket),
`jag_node_df9501cf...` (OpenAPI), `jag_node_d792f30c...` (mock server), dan
`jag_node_45dbc71a...` (performance test). ID dipendekkan untuk keterbacaan;
rekaman lengkap tersedia dalam `postman-rea-evidence.json`.

## Ruang lingkup MVP yang disarankan

1. Workspace lokal dengan collection, folder, request, environment, dan history.
2. HTTP request builder untuk params, headers, body JSON/form-data, serta Basic,
   Bearer, API Key, dan OAuth 2.
3. Response viewer untuk status, waktu, ukuran, headers, JSON, text, dan HTML.
4. Dokumentasi Markdown per collection/folder/request beserta contoh request dan
   response.
5. Impor/ekspor OpenAPI 3 dan Postman Collection v2.1.
6. Generator snippet awal untuk cURL, JavaScript `fetch`, dan Python `requests`.
7. Penyimpanan secret terpisah dari dokumen yang dapat dibagikan.

Setelah MVP stabil, tambahkan test scripts dan runner, mock server, WebSocket,
GraphQL, gRPC, kolaborasi, serta versioning. MQTT, visualizer khusus, performance
testing, dan integrasi cloud dapat ditempatkan pada fase lanjutan karena biaya
implementasi dan operasionalnya lebih besar.

## Batasan dan hal yang belum diketahui

REA melaporkan satu parse failure dan keterbatasan memori/ukuran hasil pada
sejumlah bundle besar. Analisis tidak menjalankan kode aplikasi, sehingga detail
interaksi UI, aturan sinkronisasi, hak akses tim, billing, dan kontrak layanan
cloud belum diverifikasi. Nama file saja juga tidak cukup untuk menyimpulkan
kesetaraan perilaku; implementasi kita perlu divalidasi dengan acceptance test
yang didefinisikan sendiri.
