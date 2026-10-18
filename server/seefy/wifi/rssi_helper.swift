// Streams the Mac's WiFi link readings as JSON lines, one per poll, for seefy.wifi.macos.
// Usage: rssi_helper [interval_ms]   (default 10)
// RSSI, noise and transmit rate need no Location permission; SSID and BSSID would.
import CoreWLAN
import Foundation

let intervalMs = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 10) : 10
setvbuf(stdout, nil, _IOLBF, 0)

guard let iface = CWWiFiClient.shared().interface() else {
    print("{\"error\":\"no WiFi interface\"}")
    exit(1)
}
let name = iface.interfaceName ?? ""
while true {
    if !iface.powerOn() {
        print("{\"error\":\"WiFi is off\"}")
    } else {
        let ch = iface.wlanChannel()
        print("{\"rssi\":\(iface.rssiValue()),\"noise\":\(iface.noiseMeasurement()),\"tx\":\(iface.transmitRate()),\"ch\":\(ch?.channelNumber ?? 0),\"band\":\(ch?.channelBand.rawValue ?? 0),\"if\":\"\(name)\"}")
    }
    usleep(useconds_t(intervalMs * 1000))
}
