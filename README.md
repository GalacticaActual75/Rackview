# Rackview

Rackview is a Docker dashboard for a Dell iDRAC. It reads fan RPM, temperatures, voltage, power, and other sensors available over IPMI. Its control panel can set a shared manual fan duty percentage or return control to iDRAC. The Virtual Console tab embeds the server's keyboard, video, and mouse through iDRAC VNC.

## Deploy in Arcane

Create a **Pull** Git Sync in the TrueNAS environment. Select the repository and branch, enter `compose.yaml` as the Compose path, and turn on **Sync Files** so the `app/` build context is copied with it. The image build is defined in Compose. Keep deployment settings in Arcane's project environment. [Arcane Git Sync documentation](https://getarcane.app/docs/docker/git-sync)

You can set `RACKVIEW_BIND` and `RACKVIEW_PORT` in the project's `.env`. By default Rackview is published on port `8080`. Select **Build & Deploy**, or use `docker compose up -d --build` from the project directory.

Rackview uses a Docker-managed volume by default. Set `RACKVIEW_DATA_SOURCE` in the project environment to bind a dedicated host directory for persistent settings. Prepare the directory with write access for the container's runtime UID and GID, which are both `1000`.

Rackview generates a dashboard login on first run. In Arcane, open the `rackview` container's terminal and run `cat /var/lib/rackview/dashboard-login.json` to retrieve it. To choose your own dashboard login, set `DASHBOARD_USER` and `DASHBOARD_PASSWORD` in Arcane's project environment and redeploy. Keep the project on your private network and terminate HTTPS at your reverse proxy if you use one. Forward WebSocket upgrades to the same Rackview port for the virtual console.

## Connect to iDRAC

The first visit after signing in opens **Connect your iDRAC**. Enter the iDRAC IP, username, and password. **Test connection** runs `ipmitool mc info` and displays the firmware and protocol versions. **Save connection** stores the credentials in the Docker volume. An existing password can be reused for the same IP and username by leaving the field blank.

The IPMI test requires access over UDP `623` and IPMI over LAN enabled in iDRAC. Successful read access doesn't establish permission for Dell's raw fan commands. Compatibility with these OEM commands also depends on the server firmware. [IPMItool OEM command reference](https://github.com/ipmitool/ipmitool/issues/30)

Disable the existing TrueNAS fan-control cron job when you hand fan control over to Rackview. Otherwise the cron job can switch iDRAC back to manual after you restore automatic control from Rackview. **Last fan command** reports what Rackview last confirmed during the current run. The fan mode can't be inferred from RPM or confirmed across controller resets or out-of-band changes. The app sends no fan commands when it starts. A manual command sets a fixed duty until iDRAC resumes automatic control or another controller changes it.

## Embedded Virtual Console

Open **Virtual Console** and select **VNC setup** for Dell's first-time setup paths and version-specific guides. On iDRAC8, the VNC feature requires an Enterprise license. Rackview uses the saved iDRAC IP and the VNC port and password you enter. The usual port is TCP `5901`, and the VNC password is separate from the iDRAC login password. Dell allows a single active VNC session. [Dell iDRAC8 VNC guide](https://www.dell.com/support/manuals/en-us/idrac7-8-lifecycle-controller-v2.30.30.30/idrac8_2.30.30.30_ug/using-vnc-client-to-manage-remote-server?guid=guid-bf36a9fe-9ec5-4f2b-91cd-3a428bb8eb26&lang=en-us)

Match the iDRAC VNC server's TLS setting. For a self-signed certificate, provide the verified SHA-256 fingerprint of the certificate served on the VNC port. From a trusted management network, set `IDRAC_ADDRESS` to your controller's address and run `openssl s_client -connect "${IDRAC_ADDRESS}:5901" -showcerts </dev/null | openssl x509 -noout -fingerprint -sha256`. Rackview verifies a provided fingerprint before forwarding console traffic. The embedded VNC session covers keyboard, video, and mouse. Dell manages virtual media through its native console.
