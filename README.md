# Rackview

Rackview is a Docker dashboard for a Dell iDRAC. It reads fan RPM, temperatures, voltage, power, and other sensors available over IPMI. Its control panel can set a shared manual fan duty percentage or return control to iDRAC. The Virtual Console tab embeds the server's keyboard, video, and mouse through iDRAC VNC.

## Deploy in Arcane

### 1. Connect the repository

In **Git Syncs → Git Repositories**, add this repository. For a private GitHub repo, use a read-only token for HTTPS or an SSH deploy key scoped to the repo. With SSH, add the `.pub` key in GitHub's **Settings → Deploy keys**, then enter the SSH clone URL and the matching private key in Arcane. [Arcane Git Sync documentation](https://getarcane.app/docs/docker/git-sync) · [GitHub deploy key guide](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#deploy-keys)

Create a **Pull** sync for the Docker host. Choose branch `main` and Compose file `compose.yaml`. Enable **Sync Files** so Arcane copies the `app/` build context, and leave **Redeploy After Sync** off while you configure the deployment. Run the first sync to create the project.

### 2. Set the storage path and dashboard login

Open the project in Arcane and go to **Configuration → .env**. Copy the fields from [`.env.example`](.env.example), enter your values, and save.

| Setting | What to enter |
| --- | --- |
| `RACKVIEW_DATA_SOURCE` | An absolute path to a dedicated directory on the Docker host. Leave it blank to use a Docker-managed volume. |
| `DASHBOARD_USER` | The username you want to use when signing in to Rackview. |
| `DASHBOARD_PASSWORD` | The password you want to use when signing in to Rackview. |
| `RACKVIEW_PORT` | The published host port. Defaults to `8080`. |
| `RACKVIEW_BIND` | An optional host interface address for the published port. |

If you supply a storage path, create the directory before deployment. Rackview runs as UID and GID `1000`, so UID `1000` needs permission to read, write, and traverse that directory. Keep the directory private because it stores the iDRAC connection settings and any generated dashboard login. On TrueNAS, if you created a child ZFS dataset under Arcane's project root after Arcane started, restart the Arcane manager so its mount can include the new dataset.

Keep `.env` and the files in the data directory on the deployment host. The GitHub credential is used by Arcane to pull a private copy of the repository. Dashboard users sign in with the Rackview login you configure. You will enter the iDRAC login and VNC password separately in Rackview.

### 3. Build, deploy, and sign in

Select **Build & Deploy**, then open Rackview using the Docker host address and the published port. Sign in with the dashboard login you configured. If you left the login fields blank, retrieve the generated login from the `rackview` container's terminal with `cat /var/lib/rackview/dashboard-login.json`.

For a standalone Docker installation, copy `.env.example` to `.env`, set the same fields, and run `docker compose up -d --build` from the repository directory. If you use an HTTPS reverse proxy, forward WebSocket upgrades to the Rackview port for the virtual console.

## Connect to iDRAC

The first visit after signing in opens **Connect your iDRAC**. Enter the iDRAC IP, username, and password. **Test connection** runs `ipmitool mc info` and displays the firmware and protocol versions. **Save connection** stores the credentials in the persistent data directory. An existing password can be reused for the same IP and username by leaving the field blank.

Unavailable readings are hidden by default. Select **Sensors → Show unavailable** to include them in the full sensor list.

The IPMI test requires access over UDP `623` and IPMI over LAN enabled in iDRAC. Successful read access doesn't establish permission for Dell's raw fan commands. Compatibility with these OEM commands also depends on the server firmware. [IPMItool OEM command reference](https://github.com/ipmitool/ipmitool/issues/30)

Disable the existing TrueNAS fan-control cron job when you hand fan control over to Rackview. Otherwise the cron job can switch iDRAC back to manual after you restore automatic control from Rackview. **Last fan command** reports what Rackview last confirmed during the current run. The fan mode can't be inferred from RPM or confirmed across controller resets or out-of-band changes. The app sends no fan commands when it starts. A manual command sets a fixed duty until iDRAC resumes automatic control or another controller changes it.

## Embedded Virtual Console

Open **Virtual Console** and select **VNC setup** for Dell's first-time setup paths and version-specific guides. On iDRAC8, the VNC feature requires an Enterprise license. Rackview uses the saved iDRAC IP and the VNC port and password you enter. The usual port is TCP `5901`, and the VNC password is separate from the iDRAC login password. Dell allows a single active VNC session. [Dell iDRAC8 VNC guide](https://www.dell.com/support/manuals/en-us/idrac7-8-lifecycle-controller-v2.30.30.30/idrac8_2.30.30.30_ug/using-vnc-client-to-manage-remote-server?guid=guid-bf36a9fe-9ec5-4f2b-91cd-3a428bb8eb26&lang=en-us)

Match the iDRAC VNC server's TLS setting. For a self-signed certificate, provide the verified SHA-256 fingerprint of the certificate served on the VNC port. From a trusted management network, set `IDRAC_ADDRESS` to your controller's address and run `openssl s_client -connect "${IDRAC_ADDRESS}:5901" -showcerts </dev/null | openssl x509 -noout -fingerprint -sha256`. Rackview verifies a provided fingerprint before forwarding console traffic. The embedded VNC session covers keyboard, video, and mouse. Dell manages virtual media through its native console.

If you see **VNC connected. No video received yet**, the VNC handshake completed and Rackview is still waiting for an image. Check whether the native iDRAC console can see the server's video after closing the Rackview session. Rackview omits TightPNG during VNC negotiation to avoid a known iDRAC8 compatibility issue. [noVNC issue #712](https://github.com/novnc/noVNC/issues/712)
