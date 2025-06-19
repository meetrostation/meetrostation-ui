async function initializePeerConnection() {
    const peerConnection = new RTCPeerConnection({
        iceServers: [{
            urls: "stun:stun.l.google.com:19302"
        }]
    });
    // stun:stun.l.google.com:19302
    // stun:stun.stunprotocol.org
    // stun:x.matrix.am:3478

    // peerConnection.onaddstream = function (event) {
    //     pageSetRemoteVideoStream(event.stream);
    // };
    peerConnection.ontrack = function (event) {
        // console.log('ontrack', event.track.kind);
        pageSetRemoteVideoStream(event.streams[0]);
    };

    return peerConnection;
}

async function prepareHostOffer(peerConnection, sessionData) {
    peerConnection.onicecandidate = (event) => {
        // this is what makes waitForLocalDescription functional
        //
        if (event.candidate === null) {
            // console.log('all ice candidates', event);
            const ld = JSON.stringify(peerConnection.localDescription);
            sessionData.localSessionDescription = btoa(ld);
        }
    };

    //

    // // peerConnection.addTransceiver('audio', { 'direction': 'recvonly' });
    // peerConnection.addTransceiver('video', { 'direction': 'recvonly' });
    const media = await pageGetUserMedia();
    if (media.stream) {
        media.stream.getTracks().forEach(track => peerConnection.addTrack(track, media.stream));

        pageSetLocalVideoStream(media.stream);
    }
    if (!media.audio) {
        peerConnection.addTransceiver('audio', { 'direction': 'recvonly' });
    }
    if (!media.video) {
        peerConnection.addTransceiver('video', { 'direction': 'recvonly' });
    }

    const offer = await peerConnection.createOffer();

    await peerConnection.setLocalDescription(offer);
}

async function prepareGuestAnswer(peerConnection, sessionData, hostId) {
    peerConnection.onicecandidate = (event) => {
        // this is what makes waitForLocalDescription functional
        //
        if (event.candidate === null) {
            // console.log('all ice candidates', event);
            const ld = JSON.stringify(peerConnection.localDescription);
            sessionData.localSessionDescription = btoa(ld);
        }
    };

    //
    const media = await pageGetUserMedia();
    if (media.stream) {
        media.stream.getTracks().forEach(track => peerConnection.addTrack(track, media.stream));

        pageSetLocalVideoStream(media.stream);
    }
    // if (!media.audio) {
    //     peerConnection.addTransceiver('audio', { 'direction': 'recvonly' });
    // }
    // if (!media.video) {
    //     peerConnection.addTransceiver('video', { 'direction': 'recvonly' });
    // }

    const hostSignal = await fetch(`${window.location.origin}/api/host?id=${hostId}`, {
        method: 'GET'
    });

    if (!hostSignal.ok) {
        throw Error('host not set up');
    }

    const hostSignalJson = await hostSignal.json();

    const rd = JSON.parse(atob(hostSignalJson.description));
    await peerConnection.setRemoteDescription(rd);

    const answerDescription = await peerConnection.createAnswer();
    peerConnection.setLocalDescription(answerDescription);
}

async function waitForLocalDescription(sessionData) {
    while (!sessionData.localSessionDescription) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

async function waitForPeer(peerConnection, hostId) {
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const guestSignal = await fetch(`${window.location.origin}/api/guest?hostId=${hostId}`, {
            method: 'GET'
        });

        if (!guestSignal.ok) {
            throw Error('guest not available');
        }

        const guestSignalJson = await guestSignal.json();
        if (guestSignalJson.guestDescription) {
            await peerConnection.setRemoteDescription(JSON.parse(atob(guestSignalJson.guestDescription)));

            break;
        }
    }
}

async function waitForIceConnected(peerConnection) {
    while (peerConnection.iceConnectionState === '') {
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (peerConnection.iceConnectionState !== 'connected') {
        throw Error(`unexpected iceConnectionState (connected?): ${peerConnection.iceConnectionState}`);
    }
}

async function waitForIceDisonnected(peerConnection) {
    while (peerConnection.iceConnectionState === 'connected') {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (peerConnection.iceConnectionState !== 'disconnected') {
        throw Error(`unexpected iceConnectionState (disconnected?): ${peerConnection.iceConnectionState}`);
    }
}

async function host() {
    let phase = "";
    try {
        pageStartCall();

        const sessionData = {
            localSessionDescription: ''
        };
        pageSetProgress('creating the peer connection');
        phase = "initializePeerConnection";
        const peerConnection = await initializePeerConnection();

        pageSetProgress('creating the guest answer');
        phase = "prepareHostOffer";
        await prepareHostOffer(peerConnection, sessionData);
        
        pageSetProgress('waiting for all ice candidates');
        phase = "waitForLocalDescription";
        await waitForLocalDescription(sessionData);

        phase = "signalling";
        let hostSignal = await fetch(`${window.location.origin}/api/host?id=${pageHostId()}`, {
            method: 'GET'
        });
    
        if (hostSignal.ok) {
            throw Error('host already exists');
        }

        hostSignal = await fetch(`${window.location.origin}/api/host`, {
            method: 'POST',
            body: `{"id": "${pageHostId()}", "description": "${sessionData.localSessionDescription}"}`,
            headers: {
                'Content-type': 'application/json; charset=UTF-8'
            }
        });

        if (!hostSignal.ok) {
            throw Error('cannot establish the host id');
        }

        const hostSignalJson = await hostSignal.json();

        pageSetProgress('waiting for the guest to join...');
        pageSetHostId(hostSignalJson.id);

        await waitForPeer(peerConnection, hostSignalJson.id);

        pageSetProgress('connecting...');

        phase = "waitForIceConnected";
        await waitForIceConnected(peerConnection);
        pageSetProgress('connected!');

        phase = "waitForIceDisonnected";
        await waitForIceDisonnected(peerConnection);
        pageNotify('disconnected');
    } catch (error) {
        pageNotify(`${phase}: ${error}`);
    }

    peerConnection = null;

    pageEndCall();
}

async function guest() {
    let phase = "";
    try {
        pageStartCall();

        const sessionData = {
            localSessionDescription: ''
        };
        pageSetProgress('creating the peer connection');
        phase = "initializePeerConnection";
        const peerConnection = await initializePeerConnection();

        const hostId = pageHostId();
        pageSetProgress('creating the guest answer');
        phase = "prepareGuestAnswer";
        await prepareGuestAnswer(peerConnection, sessionData, hostId);

        pageSetProgress('waiting for all ice candidates');
        phase = "waitForLocalDescription";
        await waitForLocalDescription(sessionData);

        pageSetProgress('connecting...');

        phase = "signalling";
        const guestSignal = await fetch(`${window.location.origin}/api/guest`, {
            method: 'POST',
            body: `{"hostId": "${hostId}", "guestDescription": "${sessionData.localSessionDescription}"}`,
            headers: {
                'Content-type': 'application/json; charset=UTF-8'
            }
        });

        if (!guestSignal.ok) {
            throw Error('host not found');
        }

        const guestSignalJson = await guestSignal.json();

        phase = "waitForIceConnected";
        await waitForIceConnected(peerConnection);
        pageSetProgress('connected!');

        phase = "waitForIceDisonnected";
        await waitForIceDisonnected(peerConnection);
        pageNotify('disconnected');
    } catch (error) {
        pageNotify(`${phase}: ${error}`);
    }

    peerConnection = null;

    pageEndCall();
}