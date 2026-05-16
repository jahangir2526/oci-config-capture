# OCI Config Capture

A lightweight Manifest V3 Chrome extension that captures key details from the currently active Oracle Cloud Infrastructure (OCI) Console session and displays them in a compact popup.

The extension is designed for quick inspection of the signed-in OCI Console context: tenancy, identity domain, user, region, accessible compartments, and SDK/CLI profile configuration.

## Features

- Manual **Capture** button for reading the active OCI Console tab on demand
- Capture status text that shows the latest refresh as **Updated at `<time>`**
- Refreshed popup UI with a compact brand mark, **Profile** action, session readiness badge, and copy buttons for captured values
- Red and blue cloud quick-picker extension icon for quick browser recognition
- OCI Console session detection and error handling
- Tenancy and identity-domain user details from the active browser session
- Current region detection from storage, URL/path hints, OCI service URLs loaded by the Console, visible selected-region display names, and OCI short-region code normalization
- **Profile** button that enables after a successful capture with user and tenancy OCIDs
- SDK/CLI config profile dialog with:
  - editable profile name
  - editable fingerprint field for API key fingerprints
  - private key path input with file browse helper
  - generated OCI config profile output
  - **Copy Profile** button
- API key fingerprint capture from visible **Identity > My profile > Tokens and keys > API keys** pages when fingerprints are present in the active Console view
- **Copy All** button that copies captured values in `key: value` format
- Compartment selector with:
  - accessible compartment retrieval from OCI Console/API/cache data
  - compact parent/child tree hierarchy
  - expandable and collapsible compartment branches
  - search/filter that keeps matching branches visible with their ancestors
  - selected compartment path from root to selected compartment, separated by `:`
  - selected compartment OCID display and copy button
- Footer links for the project version, LinkedIn profile, and GitHub repository

## Captured Information

The session panel displays fields in this order:

1. Tenancy name
2. Tenancy OCID
3. Identity Domain
4. Username
5. User OCID
6. Current region

The compartment selector displays compartment names in a compact hierarchy. The selected compartment path and selected compartment OCID appear below the tree.

After a successful capture, the **Profile** button opens an SDK/CLI profile generator. The generated profile follows OCI config file format:

```ini
[profile_name]
user=ocid1.user...
fingerprint=91:65:08:74:73:0f:c8:fd:61:8d:1f:75:47:bf:17:da
key_file=/Users/example/.oci/oci_api_key.pem
tenancy=ocid1.tenancy...
region=us-ashburn-1
```

The profile name and fingerprint are editable, so values can be corrected or pasted before copying the final profile.

## Install as an Unpacked Extension

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this repository folder.
6. Open an OCI Console tab and sign in.
7. Click the **OCI Config Capture** extension icon.
8. Click **Capture** to read the active OCI Console tab.
9. Click **Profile** to generate an OCI SDK/CLI config profile from the captured tenancy, user, region, fingerprint, and private key path.

No build step is required.

## Distribution Package

This is a static Manifest V3 extension, so the deployable package is a ZIP archive of the extension runtime files.

The current package name is:

```text
dist/oci-config-capture-0.1.0.zip
```

The ZIP should include:

```text
manifest.json
popup/
src/
icons/
docs/
LICENSE
README.md
```

It should not include `.git/`, generated image drafts, local development files, or unrelated repository metadata.

To rebuild the package from the repository root:

```bash
mkdir -p dist
zip -r dist/oci-config-capture-0.1.0.zip manifest.json popup src icons docs LICENSE README.md
```

## Usage

1. Open a signed-in OCI Console tab.
2. Open the extension popup.
3. Click **Capture**.
4. Use **Copy** next to any field to copy its value.
5. Use **Profile** after capture to open the SDK/CLI profile generator.
6. Edit the profile name, paste or select the API key fingerprint, and set the private key path.
7. Use **Copy Profile** to copy the generated OCI config profile.
8. Use the compartment tree to expand/collapse parent compartments.
9. Select a compartment to show its root-to-selection path in **Selected path** and its OCID in **Selected OCID**.
10. Use the search box to filter compartments; matching children remain visible with their parent path.
11. Use **Copy All** to copy the visible captured values in `key: value` format.

## How It Works

The popup asks the background service worker to inspect the active tab. If the active tab is an OCI-related Oracle Cloud host, the extension injects a content script and page probe into that tab.

The page probe runs in the OCI Console page context and gathers session hints from:

- OCI Console browser storage
- OCI Console IndexedDB caches, including `opc-key-store-v2` session tokens and cached compartment data
- decoded JWT payloads from the active identity-domain session
- selected page-level globals when present
- visible Console text and bootstrap script data as fallbacks
- selected-region display text and OCI service/resource URLs loaded by the Console
- visible API key fingerprint rows on OCI **Tokens and keys** pages
- optional same-session OCI Console/API endpoint probes when available

Username and User OCID are prioritized from the active Identity Domain session/principal data. The extension avoids treating groups, policies, roles, and other IAM metadata as the connected user.

Region extraction prefers explicit OCI region IDs, then falls back to region URL/path hints, service endpoint hostnames, and known Console display names such as `South Korea Central (Seoul)` mapping to `ap-seoul-1`.

API key fingerprints are captured only when the current visible Console page exposes fingerprint text. The profile dialog also allows manual fingerprint entry because OCI fingerprints are generated after adding an API key.

For compartments, the extension uses the tenancy OCID from the active session and attempts OCI Identity compartment data with `accessLevel=ACCESSIBLE` and `compartmentIdInSubtree=true`. If a live API request is unavailable, it falls back to cached OCI Console compartment records from IndexedDB. Parent IDs and cached path data are used to build the tree hierarchy.

Direct regional OCI Identity REST calls can return `401` in a normal browser Console session because they are unsigned OCI API requests. The extension treats those calls as optional probes and does not surface expected authorization misses as user-facing errors.

## Source Layout

```text
manifest.json          MV3 extension manifest
src/background.js      Active-tab validation and script injection
src/content.js         Isolated-world bridge and response normalization
src/page-probe.js      OCI session, user, and compartment extraction
popup/popup.html       Popup markup
popup/popup.css        Popup styling
popup/popup.js         Popup state, copy buttons, compartment tree, and profile generator logic
docs/sample-ui.svg     Example popup and profile-dialog layout
icons/                 Extension icons
dist/promo/            Generated screenshots and promo video assets
```

## Popup Layout

The sample below reflects the current popup and SDK/CLI profile dialog: branded header, Profile/Capture actions, ordered session fields, readiness badge, copy buttons, compact expandable compartment tree, selected path, selected OCID, generated profile output, and copy actions.

![Sample popup UI](docs/sample-ui.svg)

## Promo Assets

The current promo assets include an updated 30-second video with an original generated audio bed and three 1280x800 JPEG screenshots:

```text
dist/promo/oci-config-capture-promo-30s.gif
dist/promo/oci-config-capture-promo-30s.mp4
dist/promo/oci-config-capture-promo-30s.webm
dist/promo/oci-config-capture-main-popup-1280x800.jpg
dist/promo/oci-config-capture-profile-dialog-1280x800.jpg
dist/promo/oci-config-capture-profile-workflow-1280x800.jpg
```

## Extension Icon

The extension icon uses a red and blue cloud quick-picker concept:

- red outer badge for visibility in the Chrome toolbar
- blue cloud center for cloud-console context
- configuration rows for captured settings
- check target and cursor for quick picker/capture behavior

Chrome uses the PNG icon assets declared in `manifest.json`:

```text
icons/icon-16.png
icons/icon-32.png
icons/icon-48.png
icons/icon-128.png
```

The editable source icon is `icons/icon.svg`.

## Privacy and Data Handling

- The extension only reads the active tab when you click **Capture**.
- Captured values stay local to the browser extension popup.
- Recently captured API key fingerprints may be stored in local Chrome extension storage to make profile generation easier.
- The project does not send OCI data to any external service.
- If the active tab is not OCI Console, or session data cannot be read, the popup shows an error instead of failing silently.

## Development

This is a plain JavaScript Chrome extension with no build pipeline.

Useful validation commands:

```bash
node --check popup/popup.js
node --check src/content.js
node --check src/page-probe.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```
