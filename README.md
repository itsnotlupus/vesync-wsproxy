# vesync-wsproxy
A websocket proxy for the websocket connection used by etekcity wifi outlets

Notes I didn't put in the comments:

- 5 seconds push => solid blue light = airkiss/esptouch/whatever mode
  -> in this mode, the device sniffs UDP packets sent to (its own, or some agreed upon) BSSID, and derive a data stream from UDP packet lengths, presumably
  -> that means your wifi password goes in plain text over the air, for anybody listening to grab.
  ( I wish I knew how to sniff that, to see the shape of that data stream exactly. )

- ~30 seconds push => blinking blue light = "APN" mode. The device broadcasts a BSSID named "ESP\_xxxxxx" where xxxxxx are the last digits of its MAC address. The mobile app can be made to target that BSSID (by matching the ESP\_ prefix?)


