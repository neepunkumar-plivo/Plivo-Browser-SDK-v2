/* eslint-disable no-underscore-dangle */
/* eslint-disable import/no-cycle */
import {
  RTCSession,
  SessionIceCandidateEvent,
  SessionFailedEvent,
  SessionEndedEvent,
} from 'plivo-jssip';
import {
  sendCallAnsweredEvent, onIceFailure, onMediaFailure, onSDPfailure, DeviceAudioInfo,
} from '../stats/nonRTPStats';
import { emitMetrics } from '../stats/mediaMetrics';
import {
  getAudioDevicesInfo,
  startVolumeDataStreaming,
  stopVolumeDataStreaming,
} from '../media/audioDevice';
import { owaNotification } from '../utils/oneWayAudio';
import * as C from '../constants';
import {
  addCloseProtectionListeners,
  getCurrentTime,
  callStart,
  statsCollector,
  handleMediaError,
  hangupClearance,
  setEncodingParameters,
} from './util';
import { Logger } from '../logger';
import { Client, ExtraHeaders } from '../client';
import { stopAudio } from '../media/document';
import { GetRTPStats } from '../stats/rtpStats';

export interface CallSessionOptions {
  callUUID?: string;
  sipCallID: string | null;
  direction: string;
  src: string;
  dest: string;
  session: RTCSession;
  extraHeaders: ExtraHeaders;
  call_initiation_time?: number;
}

export interface CallInfo {
  callUUID: string;
  direction: string;
  src: string;
  dest: string;
  state: string;
  extraHeaders: ExtraHeaders;
}

export interface SignallingInfo {
  call_initiation_time?: number;
  answer_time?: number;
  call_confirmed_time?: number;
  post_dial_delay?: number;
  hangup_time?: number;
  hangup_party?: string;
  hangup_reason?: string;
  invite_time?: number;
  call_progress_time?: number;
  signalling_errors?: {
    timestamp: number;
    error_code: string;
    error_description: string;
  };
  ring_start_time?: number;
}

export interface MediaConnectionInformation {
  [key: string]: number;
}

const Plivo = { log: Logger, emitMetrics };

/**
 * Initializes the CallSession.
 */

export class CallSession {
  /**
   * Describes the various states of the call
   * @private
   */
  STATE: {
    INITIALIZED: string;
    RINGING: string;
    ANSWERED: string;
    REJECTED: string;
    IGNORED: string;
    CANCELED: string;
    FAILED: string;
    ENDED: string;
  };

  /**
   * Unique identifier generated for a call by server
   * @private
   */
  callUUID: string | null;

  /**
   * Identifier generated by JSSIP when a new RTCSession is created for the call
   * @private
   */
  sipCallID: string | null;

  /**
   * Specifies whether the call direction is incoming or outgoing
   * @private
   */
  direction: string;

  /**
   * Sip endpoint or a number from which a new call is made
   * @private
   */
  src: string;

  /**
   * Sip endpoint or a number to which a new call is received
   * @private
   */
  dest: string;

  /**
   * Holds the state of the incoming or outgoing call
   * @private
   */
  state: string;

  /**
   * Custom headers which are passed in the INVITE. They should start with 'X-PH'
   * @private
   */
  extraHeaders: ExtraHeaders;

  /**
   * Holds the WebRTC media session
   * @private
   */
  session: RTCSession;

  /**
   * Holds stage(call state name and time) at each state of the call
   * @private
   */
  connectionStages: string[];

  /**
   * Set to true if ice candidate gathering starts
   * @private
   */
  gotInitalIce: boolean;

  /**
   * Holds the RTP stats instance which is used for collecting rtp stats
   * @private
   */
  stats: GetRTPStats | null;

  /**
   * Holds timestamp for each state of call
   * @private
   */
  signallingInfo: SignallingInfo;

  /**
   * Holds stream status and timestamp for each state of ice connection
   * @private
   */
  mediaConnectionInfo: MediaConnectionInformation | {};

  /**
   * Delta between INVITE request and RINGING response for a call
   * @private
   */
  postDialDelayEndTime: number | null;

  /**
   * Update CallUUID in session.
   * @param {String} callUUID - active call(Outgoing/Incoming) CallUUID
   */
  public setCallUUID = (callUUID: string | null): void => {
    this.callUUID = callUUID;
  };

  /**
   * Update state in session.
   * @param {String} state - active call(Outgoing/Incoming) state(this.STATE)
   */
  public setState = (state: string): void => {
    this.state = state;
  };

  /**
   * Add stage at each state of call.
   * @param {String} stage - Has state name and time at which state change happens
   */
  public addConnectionStage = (stage: string): void => {
    this.connectionStages.push(stage);
  };

  /**
   * Get all stages for the call.
   */
  public getConnectionStages = (): string[] => this.connectionStages;

  /**
   * Add Plivo stats object.
   * @param {GetRTPStats} stats - RTP stats object
   */
  public setCallStats = (stats: GetRTPStats): void => {
    this.stats = stats;
  };

  /**
   * Clear stats timers and audio levels.
   */
  public clearCallStats = (): void => this._clearCallStats();

  /**
   * Update signalling information(holds timestamp for each state of call).
   * @param {SignallingInfo} object - contains signalling information
   */
  public updateSignallingInfo = (object: SignallingInfo): void => {
    this.signallingInfo = { ...this.signallingInfo, ...object };
  };

  /**
   * Update media connection information(holds timestamp for media stream changes).
   * @param {MediaConnectionInfo} object - contains media connection information
   */
  public updateMediaConnectionInfo = (object: MediaConnectionInformation): void => {
    this.mediaConnectionInfo = { ...this.mediaConnectionInfo, ...object };
  };

  /**
   * Get signalling information.
   */
  public getSignallingInfo = (): SignallingInfo => ({
    ...this.signallingInfo,
    ...{
      post_dial_delay:
      this.postDialDelayEndTime ? this.postDialDelayEndTime : 0
      - (this.signallingInfo as any).call_initiation_time,
    },
  });

  /**
   * Get media connection information.
   */
  public getMediaConnectionInfo = (): MediaConnectionInformation => (
    { ...this.mediaConnectionInfo }
  );

  /**
   * Add PostDialDelay(Delta between INVITE request and RINGING response) for a call.
   * @param {Number} time - current timestamp
   */
  public setPostDialDelayEndTime = (time: number): void => {
    if (!this.postDialDelayEndTime) this.postDialDelayEndTime = time;
  };

  /**
   * Get basic call information.
   */
  public getCallInfo = (): CallInfo => ({
    callUUID: this.callUUID as string,
    direction: this.direction,
    src: this.src,
    dest: this.dest,
    state: this.state,
    extraHeaders: this.extraHeaders,
  });

  /**
   * Triggered when the user answers the call(Outgoing/Incoming) and got or received 200 OK.
   * @param {Client} clientObject - client reference
   */
  public onAccepted = (cs: Client): void => this._onAccepted(cs);

  /**
   * Triggered when the user answers the call(Outgoing/Incoming) and got or received ACK.
   * @param {Client} clientObject - client reference
   */
  public onConfirmed = (cs: Client): void => this._onConfirmed(cs);

  /**
   * Triggered when a new ice candidate is gathered.
   * @param {Client} clientObject - client reference
   * @param {SessionIceCandidateEvent} event - rtcsession information
   */
  public onIceCandidate = (
    cs: Client,
    event: SessionIceCandidateEvent,
  ): void => this._onIceCandidate(cs, event);

  /**
   * Triggered when ice candidates gathering is timed out.
   * @param {Client} clientObject - client reference
   * @param {Number} sec - ice timeout seconds
   */
  public onIceTimeout = (cs: Client, sec: number): void => this._onIceTimeout(cs, sec);

  /**
   * Triggered when a call(Outgoing/Incoming) is rejected or invalid.
   * @param {Client} clientObject - client reference
   * @param {SessionFailedEvent} evt - rtcsession information
   */
  public onFailed = (cs: Client, event: SessionFailedEvent): void => this._onFailed(cs, event);

  /**
   * Triggered when a call(Outgoing/Incoming) hung up.
   * @param {Client} clientObject - client reference
   * @param {SessionEndedEvent} evt - rtcsession information
   */
  public onEnded = (cs: Client, event: SessionEndedEvent): void => this._onEnded(cs, event);

  /**
   * Triggered when user media is not accessible.
   * @param {Client} clientObject - client reference
   * @param {Error} err - reason for issue
   */
  public onGetUserMediaFailed = (
    cs: Client,
    error: Error | DOMError,
  ): void => this._onGetUserMediaFailed(cs, error);

  /**
   * Triggered when peer connection issues(creating offer, answer and setting description) occur.
   * @param {Client} clientObject - client reference
   * @param {String} msg - type of issue
   * @param {Function} callStatscb - callstats.io callback for each issue
   * @param {Error} err - reason for issue
   */
  public handlePeerConnectionFailures = (
    cs: Client,
    msg: string | Error | DOMError,
    callStatscb: () => void,
    err: Error | DOMError,
  ): void => this._handlePeerConnectionFailures(cs, msg, callStatscb, err);

  /**
   * @constructor
   * @param {CallSessionOptions} options - call(Outgoing/Incoming) information
   * @private
   */
  constructor(options: CallSessionOptions) {
    this.STATE = {
      INITIALIZED: 'initialized',
      RINGING: 'ringing',
      ANSWERED: 'answered',
      REJECTED: 'rejected',
      IGNORED: 'ignored',
      CANCELED: 'canceled',
      FAILED: 'failed',
      ENDED: 'ended',
    };

    this.callUUID = options.callUUID ? options.callUUID : null;
    this.sipCallID = options.sipCallID;
    this.direction = options.direction;
    this.src = options.src;
    this.dest = options.dest;
    this.state = this.STATE.INITIALIZED;
    this.extraHeaders = options.extraHeaders;
    this.session = options.session;
    this.connectionStages = [];
    this.gotInitalIce = false;
    this.stats = null;
    this.signallingInfo = {};
    this.mediaConnectionInfo = {};

    if (options.call_initiation_time) {
      this.signallingInfo.call_initiation_time = options.call_initiation_time;
    }
    this.postDialDelayEndTime = null;
  }

  private _clearCallStats = (): void => {
    if (!this.stats) return;
    clearInterval(this.stats.statsTimer);
    clearInterval(this.stats.audioTimer);
    this.stats.stop();
    this.stats = null;
  };

  private _onAccepted = (clientObject: Client): void => {
    addCloseProtectionListeners.call(clientObject);
    getAudioDevicesInfo
      .call(clientObject)
      .then((deviceInfo: DeviceAudioInfo) => {
        sendCallAnsweredEvent.call(clientObject, deviceInfo, true);
      })
      .catch(() => {
        sendCallAnsweredEvent.call(clientObject, null, true);
      });
    this.updateSignallingInfo({
      answer_time: getCurrentTime(),
    });
    callStart.call(clientObject);
    startVolumeDataStreaming(clientObject);
  };

  private _onConfirmed = (clientObject: Client): void => {
    this.addConnectionStage(`confirmed@${getCurrentTime()}`);
    this.setState(this.STATE.ANSWERED);
    this.updateSignallingInfo({
      call_confirmed_time: getCurrentTime(),
    });
    // enable expedited forwarding for dscp
    setEncodingParameters.call(clientObject);
    // disableRtpTimeOut if enabled
    if (clientObject.options.disableRtpTimeOut) {
      (this.session.connection as any).disableRtpTimeOut = true;
    }
    statsCollector.call(clientObject, this);
    if (clientObject.ringToneView && !clientObject.ringToneView.paused) {
      stopAudio(C.RINGTONE_ELEMENT_ID);
    }
    if (clientObject.ringBackToneView && !clientObject.ringBackToneView.paused) {
      stopAudio(C.RINGBACK_ELEMENT_ID);
    }
    clientObject.emit('onCallAnswered', this.getCallInfo());
    Plivo.log.debug('Post-Answer detecting OWA');
    setTimeout(() => {
      owaNotification.bind(clientObject);
    },
    3000,
    this.session.connection,
    clientObject);
  };

  private _onIceCandidate = (
    clientObject: Client,
    event: SessionIceCandidateEvent,
  ): void => {
    const { candidate } = event;
    if (candidate && candidate.candidate.search('srflx') !== -1) {
      event.ready();
      return;
    }
    if (this.gotInitalIce) return;
    this.gotInitalIce = true;
    setTimeout(() => {
      if (!this.session) return;
      const { connection } = this.session;
      if (connection && connection.iceGatheringState !== 'complete') {
        event.ready();
        Plivo.log.debug(
          `ice gathering taking more than ${C.ICE_GATHERING_TIMEOUT / 1000} sec ${connection.iceGatheringState}`,
        );
        Plivo.emitMetrics.call(
          clientObject,
          'network',
          'warning',
          'ice_timeout',
          C.ICE_GATHERING_TIMEOUT,
          true,
          'Possible NAT/Firewall issue',
          'None',
        );
      }
    }, C.ICE_GATHERING_TIMEOUT);
  };

  private _onIceTimeout = (clientObject: Client, sec: number): void => {
    Plivo.log.debug('ice gathering timed out');
    Plivo.emitMetrics.call(
      clientObject,
      'network',
      'warning',
      'ice_timeout',
      sec,
      true,
      'Possible NAT/Firewall issue',
      'None',
    );
    onIceFailure.call(clientObject, this, new Error('ice_timeout'));
  };

  private _onFailed = (clientObject: Client, evt: SessionFailedEvent): void => {
    this.addConnectionStage(`failed@${getCurrentTime()}`);
    this.updateSignallingInfo({
      hangup_time: getCurrentTime(),
      hangup_party: evt.originator,
      hangup_reason: evt.cause,
    });
    handleMediaError(evt, this);
    hangupClearance.call(clientObject, this);
    stopVolumeDataStreaming();
  };

  private _onEnded = (clientObject: Client, evt: SessionEndedEvent): void => {
    this.addConnectionStage(`ended@${getCurrentTime()}`);
    this.setState(this.STATE.ENDED);
    this.updateSignallingInfo({
      hangup_time: getCurrentTime(),
      hangup_party: evt.originator,
      hangup_reason: evt.cause,
    });
    if (clientObject.callStats) {
      clientObject.callStats.sendFabricEvent(
        this.session.connection,
        clientObject.callStats.fabricEvent.fabricTerminated,
        this.callUUID,
      );
    }
    if (clientObject._currentSession) {
      clientObject.emit(
        'onCallTerminated',
        { originator: evt.originator, reason: evt.cause },
        clientObject._currentSession.getCallInfo(),
      );
      hangupClearance.call(clientObject, clientObject._currentSession);
      stopVolumeDataStreaming();
    }
  };

  private _onGetUserMediaFailed = (
    clientObject: Client,
    err: Error | DOMError,
  ): void => {
    Plivo.log.error(`getusermediafailed: ${err}`);
    if (clientObject.userName && clientObject.callStats) {
      // eslint-disable-next-line no-param-reassign
      (err as Error).message = 'getusermediafailed';
      clientObject.callStats.reportError(
        null,
        clientObject.userName,
        clientObject.callStats.webRTCFunctions.getUserMedia,
        err,
      );
    }
    onMediaFailure.call(clientObject, this, err as Error);
  };

  private _handlePeerConnectionFailures = (
    clientObject: Client,
    msg: string | Error | DOMError,
    callStatscb: () => void,
    err: Error | DOMError,
  ): void => {
    if (clientObject.userName && clientObject.callStats && callStatscb) {
      // eslint-disable-next-line no-param-reassign
      (err as Error).message = `peerconnection:${msg}`;
      clientObject.callStats.reportError(
        null,
        clientObject.userName,
        callStatscb,
        err,
      );
    }
    onSDPfailure.call(clientObject, this, err as Error);
  };
}
