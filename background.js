const messageHandler = async message => {
    console.log('[background.js] message received: ', message);
    if (message.event_type === 'chat_message') {
        if (message.message[0] === '/') {
            const command = message.message.split(' ')[0].slice(1);
            switch (command) {
                case 'hints':
                case 'h':
                    surflyExtension.tabs.sendMessage(null, {event_type: 'command', command: 'hints'});
                    break;
                case 'help':
                case 'h':
                    surflyExtension.surflySession.apiRequest({cmd: 'send_chat_message', message: `✨ Agent: Available commands: /start <prompt>, /next, /hints, /auto <on|off>, /screenshots <on|off>, /help`});
                    break;
            }
        }
    } else if (message.event_type === 'command') {
        console.log('[background.js] command received: ', message);
        surflyExtension.tabs.sendMessage(null, {event_type: 'command', ...message});
    }
}

function init() {
    let handlerAdded = false;
    surflyExtension.surflySession.onMessage.addListener(message => {
        if (message?.msg === 'get_session_participants' && !handlerAdded) {
            const me = message.participants.find(participant => !!participant.self);
            if (me.client_index === 1) {
                handlerAdded = true;
                surflyExtension.surflySession.onMessage.addListener(messageHandler);
            }
        }
    })

    surflyExtension.surflySession.apiRequest({cmd: 'get_session_participants'})
}

setTimeout(init, 1000)