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

async function waitForLocalDescription(peerConnection, sessionData) {
    peerConnection.oniceconnectionstatechange = (event) => {
        // this is what makes waitForIceConnected functional
        //
        // console.log('ice connection state: ' + event.target.iceConnectionState);
        if (event.target.iceConnectionState !== 'checking') {
            sessionData.iceConnectionState = event.target.iceConnectionState;
        }
    };

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

async function waitForIceConnected(peerConnection, sessionData) {
    while (sessionData.iceConnectionState === '') {
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (sessionData.iceConnectionState !== 'connected') {
        throw Error(`unexpected iceConnectionState (connected?): ${sessionData.iceConnectionState}`);
    }

    peerConnection.oniceconnectionstatechange = (event) => {
        // this is what makes waitForIceDisonnected functional
        //
        // console.log('ice connection: ', event.target.iceConnectionState);
        sessionData.iceConnectionState = event.target.iceConnectionState;
    };
}

async function waitForIceDisonnected(sessionData) {
    while (sessionData.iceConnectionState === 'connected') {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (sessionData.iceConnectionState !== 'disconnected') {
        throw Error(`unexpected iceConnectionState (disconnected?): ${sessionData.iceConnectionState}`);
    }
}

async function host() {
    try {
        pageStartCall();

        const sessionData = {
            localSessionDescription: '',
            iceConnectionState: ''
        };
        const peerConnection = await initializePeerConnection();

        await prepareHostOffer(peerConnection, sessionData);

        await waitForLocalDescription(peerConnection, sessionData);

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
            throw Error('cannot establish the id');
        }

        const hostSignalJson = await hostSignal.json();

        pageSetProgress('waiting for the guest to join...');
        pageSetHostId(hostSignalJson.id);

        await waitForPeer(peerConnection, hostSignalJson.id);

        pageSetProgress('connecting...');

        await waitForIceConnected(peerConnection, sessionData);
        pageSetProgress('connected!');

        await waitForIceDisonnected(sessionData);
        pageNotify('disconnected');
    } catch (error) {
        pageNotify(error);
    }

    peerConnection = null;

    pageEndCall();
}

async function guest() {
    try {
        pageStartCall();

        const sessionData = {
            localSessionDescription: '',
            iceConnectionState: ''
        };
        const peerConnection = await initializePeerConnection();

        const hostId = pageHostId();
        await prepareGuestAnswer(peerConnection, sessionData, hostId);

        await waitForLocalDescription(peerConnection, sessionData);

        pageSetProgress('connecting...');

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

        await waitForIceConnected(peerConnection, sessionData);
        pageSetProgress('connected!');

        await waitForIceDisonnected(sessionData);
        pageNotify('disconnected');
    } catch (error) {
        pageNotify(error);
    }

    peerConnection = null;

    pageEndCall();
}