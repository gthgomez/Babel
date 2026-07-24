<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
status: ACTIVE
last_verified: 2026-07-03
-->

# Skill: Android Raw Sockets, SSDP & TLS Pairing (v1.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `domain_android_kotlin`
**Last Verified:** 2026-06-26
**Activation:** Load for tasks implementing local network discovery (SSDP, mDNS/NSD), raw TCP/UDP socket connections, Google TV pairing protocol v2, or TLS certificate client handshakes.

---

## Purpose

Android devices enforce strict network boundaries: background sockets are aggressively throttled, UDP multicast packets are dropped unless an explicit system lock is acquired, and raw SSL/TLS socket handshakes fail unless custom certificate trust managers are wired correctly for local device PIN-pairing.

This skill governs raw socket management, multicast lock lifecycle, and secure TLS socket handshakes on Android.

---

## Step 1 — WiFi Multicast Lock Lifecycle

SSDP uses UDP multicast address `239.255.255.250` on port `1900`. Android drops incoming multicast packets by default to preserve battery. You must acquire a `MulticastLock`.

### Rules
1. **Acquiring and Releasing Locks:** Always acquire the lock before binding the socket and release it in a `finally` block:
   ```kotlin
   val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
   val multicastLock = wifiManager.createMulticastLock("SSDP_DISCOVERY_LOCK")
   
   multicastLock.acquire()
   try {
       // Perform UDP multicast bind and receive...
   } finally {
       if (multicastLock.isHeld) {
           multicastLock.release()
       }
   }
   ```
2. **Permission Guard:** The app must declare the multicast permission in `AndroidManifest.xml`:
   ```xml
   <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
   ```

---

## Step 2 — UDP/SSDP Discovery Loop

UDP sockets are unreliable and can block indefinitely if timeouts are not set.

### Rules
1. **SSDP M-SEARCH Formatting:** Format the query string with trailing CRLF (`\r\n`) sequences exactly as specified by ECP:
   ```kotlin
   val mSearchQuery = "M-SEARCH * HTTP/1.1\r\n" +
           "HOST: 239.255.255.250:1900\r\n" +
           "MAN: \"ssdp:discover\"\r\n" +
           "MX: 3\r\n" +
           "ST: rook:device\r\n\r\n"
   ```
2. **Socket Timeout Enforcement:** Always set a strict `soTimeout` on the socket to prevent threads from locking forever:
   ```kotlin
   DatagramSocket().use { socket ->
       socket.soTimeout = 3000 // 3 seconds timeout
       val sendData = mSearchQuery.toByteArray()
       val sendPacket = DatagramPacket(sendData, sendData.size, InetAddress.getByName("239.255.255.250"), 1900)
       socket.send(sendPacket)

       val receiveData = ByteArray(1024)
       while (isActive) { // Coroutine scope check
           val receivePacket = DatagramPacket(receiveData, receiveData.size)
           try {
               socket.receive(receivePacket)
               val response = String(receivePacket.data, 0, receivePacket.length)
               parseSsdpResponse(response)
           } catch (e: SocketTimeoutException) {
               break // Timeout hit, exit loop safely
           }
       }
   }
   ```

---

## Step 3 — Android Keystore Client Certification

Secure TV pairing (e.g. Google TV Remote Protocol v2) requires generating client certificates on the device and storing them in the Android Keystore to sign pairing requests.

### Rules
1. **Generating KeyPairs in Keystore:** Create keys with cryptographic strength inside the secure hardware environment:
   ```kotlin
   val keyPairGenerator = KeyPairGenerator.getInstance(
       KeyProperties.KEY_ALGORITHM_EC,
       "AndroidKeyStore"
   )
   val spec = KeyGenParameterSpec.Builder(
       "TV_REMOTE_ALIAS",
       KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
   )
       .setDigests(KeyProperties.DIGEST_SHA256)
       .build()
   keyPairGenerator.initialize(spec)
   val keyPair = keyPairGenerator.generateKeyPair()
   ```
2. **Self-Signed Certificate Generation:** Generate a self-signed X.509 certificate using standard security providers (BouncyCastle or local platform wrapper) and associate it with the key entry.

---

## Step 4 — Custom SSL/TLS Socket Handshake

Local devices use self-signed certificates with dynamic public keys. Standard trust managers will fail verification. You must write a custom TrustManager.

### Rules
1. **PIN-Trust Manager:** Never disable SSL checks globally (no `TrustAllManager`). Implement a TrustManager that compares the server's certificate public key hash against the verified certificate hash received during the visual PIN-pairing exchange:
   ```kotlin
   class PinTrustManager(private val expectedCertHash: String) : X509TrustManager {
       override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
       override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
           if (chain.isNullOrEmpty()) throw CertificateException("Empty certificate chain")
           val serverCert = chain[0]
           val actualHash = computeSha256Hash(serverCert.publicKey.encoded)
           if (actualHash != expectedCertHash) {
               throw CertificateException("Server public key hash mismatch! Expected $expectedCertHash but got $actualHash")
           }
       }
       override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
   }
   ```
2. **Wired SSLSocket Initialization:** Build the custom SSLContext and generate the client socket:
   ```kotlin
   val sslContext = SSLContext.getInstance("TLSv1.3")
   sslContext.init(
       arrayOf(clientKeyManager), // Loads client certificate from Keystore
       arrayOf(PinTrustManager(savedTvCertHash)),
       SecureRandom()
   )
   val socket = sslContext.socketFactory.createSocket(tvIpAddress, 6467) as SSLSocket
   socket.soTimeout = 5000
   socket.startHandshake() // Handshake will fail if PIN certificate mismatches
   ```

---

## Hard Rules

1. **Never perform raw socket read/write operations on the Main thread.** Always launch within `Dispatchers.IO`.
2. **Always release the `WifiManager.MulticastLock`** in a `finally` block to prevent severe device battery drain.
3. **Never implement a TrustManager that performs zero verification** (`TrustAll`). Always pin the certificate by key hash.
4. **Always set a timeout (`soTimeout`)** on every socket. Sockets without timeouts are the leading cause of background service freezes.
5. **Never expose raw private keys from KeyStore.** Keep key signing internal to KeyStore providers.

---

## Boundaries — Do Not Overstep

- This skill defines local network socket and TLS pairing rules. It does not replace official Android network security configuration guides, Java Socket APIs, or standard RFC cryptography specs.
- Port-specific rules (Roku ECP on `8060`, Google TV Remote on `6466`/`6467`) are local and must not be cross-pollinated.

---

## Failure Behavior of This Skill

- **SSDP socket receives no responses on real devices:** Verify if `MulticastLock` was actually acquired before bind. Ensure permissions are declared in the Manifest.
- **SSLHandshakeException during pairing:** Check the TrustManager key hash calculation format. Ensure the TV's certificate hasn't expired or regenerated.

---

## Strategic Next Move

After every substantial response, end with one strategic next-move question focused on the socket lifecycle, connection timeout values, or multicast state checking.

---

## References

- `ols-compiler` (`04_Meta_Tools/OLS-MCC/ols-compiler/SKILL.md`) — for verifying socket invariants.
- `skill_android_permissions` (`Mobile/Platform/Android-Permissions-v2.md`) — for network permission checkouts.

---

**OLS-MCC Compliance:** v1.0 compiled and validated for Phase 1 Native Integration (Sockets/TLS).
