/* eslint func-names: ["error", "as-needed"] */
import * as SipLib from 'plivo-jssip';
import * as C from '../constants';
import { Logger } from '../logger';
// eslint-disable-next-line import/no-cycle
import { Client, PlivoObject } from '../client';
import { FeedbackObject } from '../utils/feedback';

export interface CallStatsValidationResponse {
  data: string;
  is_rtp_enabled: boolean;
}

export interface PreSignedUrlRequest {
  username: string;
  password: string;
  domain: string;
  calluuid: string;
}

export interface PreSignedUrlResponse {
  data: string;
}

const Plivo: PlivoObject = { log: Logger };

/**
 * Get callstats key and rtp enabled status.
 * @param {String} userName
 * @param {String} password
 * @returns Fulfills with call insights key and rtp enabled status or reject with error
 */
export const validateCallStats = function (
  userName: string, password: string,
): Promise<CallStatsValidationResponse | string> {
  return new Promise((resolve, reject) => {
    const statsApiUrl = new URL(C.STATS_API_URL);
    const statsHeaders = new Headers();
    statsHeaders.append('Content-Type', 'application/json');
    // Remove the 'sip' prefix if present in the username before sending request to plivo stats
    let username = userName;
    if (userName.toLowerCase().startsWith('sip:')) {
      // eslint-disable-next-line prefer-destructuring
      username = userName.split(':')[1];
    }
    const statsBody = {
      username,
      password,
      domain: C.DOMAIN,
    };

    fetch(statsApiUrl as any, {
      method: 'POST',
      headers: statsHeaders,
      body: JSON.stringify(statsBody),
    })
      .then((response) => {
        if (response.ok) {
          response.text().then((responsebody: string) => {
            if (!responsebody) {
              Plivo.log.info('Call insights is not enabled');
              // eslint-disable-next-line prefer-promise-reject-errors
              reject('Call insights is not enabled');
            } else {
              const parsedResponseBody = JSON.parse(responsebody);
              resolve(parsedResponseBody);
            }
          });
        } else {
          // eslint-disable-next-line prefer-promise-reject-errors
          reject('Incorrect response code');
        }
      })
      .catch((err) => {
        Plivo.log.error('Error in getting token from call stats', err);
        reject(err);
      });
  });
};

/**
 * Get presigned s3 url to upload console logs.
 * @param {PreSignedUrlRequest} preSignedUrlBody - request body for getting pre-signed s3 url
 * @returns Fulfills with pre-signed s3 url or reject with error
 */
export const getPreSignedS3URL = (
  preSignedUrlBody: PreSignedUrlRequest,
): Promise<PreSignedUrlResponse | string> => {
  const url = new URL(C.S3BUCKET_API_URL);
  return new Promise((resolve, reject) => {
    fetch(url as any, {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(preSignedUrlBody),
    })
      .then((response) => {
        if (response.ok) {
          response
            .text()
            .then((responseBody) => {
              if (!responseBody) {
                Plivo.log.error('Response is not valid');
                // eslint-disable-next-line prefer-promise-reject-errors
                reject('Response is not valid');
                return;
              }
              resolve(JSON.parse(responseBody));
            })
            .catch((error) => {
              Plivo.log.error('Did not get s3 url to upload', error);
              // eslint-disable-next-line prefer-promise-reject-errors
              reject('Did not get s3 url to upload');
            });
        } else {
          Plivo.log.error(
            'WS API server did not return the presigned S3 Url for uploading call logs',
          );
          // eslint-disable-next-line prefer-promise-reject-errors
          reject('Bad response from server');
        }
      })
      .catch((error) => {
        Plivo.log.error(
          'WS API server did not return the presigned S3 Url for uploading call logs',
          error,
        );
        // eslint-disable-next-line prefer-promise-reject-errors
        reject(
          'API server did not return the presigned S3 Url for uploading call logs',
        );
      });
  });
};

/**
 * Upload logs to s3 bucket using pre-signed s3 url.
 * @param {PreSignedUrlResponse} preSignedUrlReponse - contains pre-signed s3 url
 * @param {FeedbackObject} feedback - contains call rating, issues faced during call and remarks
 * @returns Fulfills with done status or reject with error
 */
export const uploadConsoleLogsToBucket = function (
  preSignedUrlReponse: PreSignedUrlResponse,
  feedback: FeedbackObject,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const signedS3URL = new URL(preSignedUrlReponse.data);
    const content = Plivo.log.consolelogs();
    const fileContent: any[] = [];
    if (feedback) fileContent.push(`${JSON.stringify(feedback)} \n`);
    fileContent.push(content);
    const file = new Blob(fileContent, { type: 'text/plain;charset=utf-8' });
    const myHeaders = new Headers();
    myHeaders.append('Content-Type', 'text/plain');

    fetch(signedS3URL as any, {
      method: 'PUT',
      headers: myHeaders,
      body: file,
    })
      .then(() => {
        Plivo.log.info('Log file uploaded to server');
        resolve('done');
      })
      .catch((err) => {
        Plivo.log.error('Log file was not uploaded to server', err);
        // eslint-disable-next-line prefer-promise-reject-errors
        reject('Log file was not uploaded to server');
      });
  });
};

export const fetchIPAddress = (
  client: Client,
): Promise<string | Error> => new Promise((resolve) => {
  const message = new SipLib.Message(client.phone as SipLib.UA);
  message.on('succeeded', (data) => {
    if (data.response && data.response.body) {
      resolve(data.response.body);
    } else {
      resolve(new Error("couldn't retrieve ipaddress"));
    }
  });
  message.on('failed', () => {
    resolve(new Error("couldn't retrieve ipaddress"));
  });
  message.send('admin', 'ipAddress', 'MESSAGE');
});
