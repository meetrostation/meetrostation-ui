async function initializePeerConnection() {
    const peerConnection = new RTCPeerConnection({
        iceServers: [{
            urls: 'stun:stun.l.google.com:19302'
        }]
    });
    // stun:stun.l.google.com:19302
    // stun:stun.stunprotocol.org

    // peerConnection.onaddstream = function (event) {
    //     pageSetRemoteVideoStream(event.stream);
    // };
    peerConnection.ontrack = function (event) {
        // console.log('ontrack', event.track.kind);
        pageSetRemoteVideoStream(event.streams[0]);
    };

    return peerConnection;
}

function prepareDataChannel(peerConnection, sessionData) {
    const dataChannel = peerConnection.createDataChannel('meetrostation', {
        ordered: true,
        negotiated: true,
        id: 0
    });
    dataChannel.onopen = () => {
        sessionData.dataChannel = dataChannel;
        dataChannel.onmessage = (message) => {
            dataChannelHandler(message.data);
            console.log(message.data);
        }
    };
    dataChannel.onclose = () => {
        sessionData.dataChannel = null;
    };
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

    const media = await pageGetUserMedia();
    if (media.stream) {
        for (const track of media.stream.getTracks()) {
            peerConnection.addTrack(track, media.stream);
        }

        pageSetLocalVideoStream(media.stream);
    }
    if (!media.audio) {
        peerConnection.addTransceiver('audio', { 'direction': 'recvonly' });
    }
    if (!media.video) {
        peerConnection.addTransceiver('video', { 'direction': 'recvonly' });
    }

    prepareDataChannel(peerConnection, sessionData);

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

    const media = await pageGetUserMedia();
    if (media.stream) {
        for (const track of media.stream.getTracks()) {
            peerConnection.addTrack(track, media.stream);
        }

        pageSetLocalVideoStream(media.stream);
    }
    // if (!media.audio) {
    //     peerConnection.addTransceiver('audio', { 'direction': 'recvonly' });
    // }
    // if (!media.video) {
    //     peerConnection.addTransceiver('video', { 'direction': 'recvonly' });
    // }

    prepareDataChannel(peerConnection, sessionData);

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
    while (['new', 'checking', 'disconnected'].indexOf(peerConnection.iceConnectionState) !== -1) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (peerConnection.iceConnectionState !== 'connected') {
        throw Error(`unexpected iceConnectionState (connected?): ${peerConnection.iceConnectionState}`);
    }
}

async function waitForIceDisonnected(peerConnection, sessionData) {
    while (peerConnection.iceConnectionState === 'connected' && sessionData.dataChannel !== null) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (peerConnection.iceConnectionState === 'connected') {
        throw Error('unexpected dataChannel loss');
    } else if (peerConnection.iceConnectionState !== 'disconnected') {
        throw Error(`unexpected iceConnectionState (disconnected?): ${peerConnection.iceConnectionState}`);
    }
}

function getIpAddressUtility(description) {
    return description.sdp.split('\r\n')
        .filter(
            function (line) {
                return line.indexOf('c=IN IP4 ') === 0;
            }
        )
        .filter(function (line, index, array) {
            return array.indexOf(line) === index;
        })
        .map(function (line) {
            return line.substring(9);
        })
        .filter(function (line) {
            return line !== '0.0.0.0';
        })
        .join(',');
}

function setUpDataChannelUtility(sessionData) {
    for (const prefix of ['lu', 'u', 'ru', 'l', 'r', 'ld', 'd', 'rd']) {
        const button = document.getElementById(`${prefix}Button`);
        button.addEventListener('mousedown', function (event) {
            if (sessionData.dataChannel) {
                sessionData.dataChannel.send(`${prefix}p`);
            }
        }, false);
        button.addEventListener('mouseup', function (event) {
            if (sessionData.dataChannel) {
                sessionData.dataChannel.send(`${prefix}r`);
            }
        }, false);

        pageButtonReleased(`${prefix}Button`);
    }
}

function dataChannelHandler(message) {
    const action = message.substring(message.length - 1);
    const prefix = message.substring(0, message.length - 1);

    if (action === 'p') {
        pageButtonPressed(`${prefix}Button`);
    } else if (action === 'r') {
        pageButtonReleased(`${prefix}Button`);
    }
}

async function host() {
    let phase = '';
    try {
        pageStartCall();

        const sessionData = {
            localSessionDescription: '',
            dataChannel: undefined
        };
        pageSetProgress('creating the peer connection');
        phase = 'initializePeerConnection';
        const peerConnection = await initializePeerConnection();

        pageSetProgress('creating the guest answer');
        phase = 'prepareHostOffer';
        await prepareHostOffer(peerConnection, sessionData);

        pageSetProgress('waiting for all ice candidates');
        phase = 'waitForLocalDescription';
        await waitForLocalDescription(sessionData);

        phase = 'signalling';
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

        phase = 'waitForIceConnected';
        await waitForIceConnected(peerConnection);

        const localIpAddress = getIpAddressUtility(peerConnection.localDescription);
        const remoteIpAddress = getIpAddressUtility(peerConnection.remoteDescription);

        pageSetProgress(`connected:${localIpAddress}<=>${remoteIpAddress}`);

        setUpDataChannelUtility(sessionData);

        phase = 'waitForIceDisonnected';
        await waitForIceDisonnected(peerConnection, sessionData);
        pageNotify('disconnected');
    } catch (error) {
        pageNotify(`${phase}: ${error}`);
    }

    peerConnection = null;

    pageEndCall();
}

async function guest() {
    let phase = '';
    try {
        pageStartCall();

        const sessionData = {
            localSessionDescription: '',
            dataChannel: undefined
        };
        pageSetProgress('creating the peer connection');
        phase = 'initializePeerConnection';
        const peerConnection = await initializePeerConnection();

        const hostId = pageHostId();
        pageSetProgress('creating the guest answer');
        phase = 'prepareGuestAnswer';
        await prepareGuestAnswer(peerConnection, sessionData, hostId);

        pageSetProgress('waiting for all ice candidates');
        phase = 'waitForLocalDescription';
        await waitForLocalDescription(sessionData);

        pageSetProgress('connecting...');

        phase = 'signalling';
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

        phase = 'waitForIceConnected';
        await waitForIceConnected(peerConnection);

        const localIpAddress = getIpAddressUtility(peerConnection.localDescription);
        const remoteIpAddress = getIpAddressUtility(peerConnection.remoteDescription);

        pageSetProgress(`connected:${localIpAddress}<=>${remoteIpAddress}`);

        setUpDataChannelUtility(sessionData);

        phase = 'waitForIceDisonnected';
        await waitForIceDisonnected(peerConnection, sessionData);
        pageNotify('disconnected');
    } catch (error) {
        pageNotify(`${phase}: ${error}`);
    }

    peerConnection = null;

    pageEndCall();
}