import * as express from 'express';
import * as cors from 'cors';
import { join ,normalize} from 'path';
import { createServer, request } from 'http';
import {readFile, unlink, readdirSync, statSync, ensureFileSync, writeFileSync ,existsSync} from 'fs-extra';
import * as xml from 'xml';
import * as bodyParser from 'body-parser';
import * as convert from 'xml-js';
import * as e2p from 'event-to-promise';
import * as serveStatic from "serve-static";
import * as glob from 'glob';
import * as o2x from 'object-to-xml';
import * as uuid from 'uuid';
import * as md5 from 'md5-file';
import * as etag from 'etag';

import { StorageSimulatorServerConfig } from '../index';


var corsOptions = {
  maxAge: 20000,
  exposedHeaders: ['x-amz-server-side-encryption', 'x-amz-request-id', 'x-amz-id-2', 'ETag']
}
export class StorageServer {
  private app;
  private server;
  private connection;
  private route; // bucket name get from the CFN parser
  url: string;
  private uploadId;
  private localDirectoryPath: string;

  constructor(
    private config: StorageSimulatorServerConfig,
  ) {
    this.localDirectoryPath = config.localDirS3;
    //console.log("path file", this.localDirectoryPath);
    this.app = express();
    this.app.use(express.json());
    this.app.use(cors(corsOptions));
    //this.app.set('etag', false);
    //this.app.use('/', express.static(STATIC_ROOT))
    this.app.use(bodyParser.raw({ limit: '100mb', type: '*/*' }));
    this.app.use(bodyParser.json({ limit: '50mb', type: '*/*' }));
    this.app.use(bodyParser.urlencoded({ limit: '50mb', extended: false, type: '*/*' }));
    this.app.use(serveStatic(this.localDirectoryPath), this.handleRequestAll.bind(this));

    this.server = null;
    this.route = config.route;
    //console.log("config object = ", config);
    //console.log("route path = ", this.route + ':path');

    //this.app.get(this.route +':path', this.handleRequestGet.bind(this));
    //this.app.put(this.route +':path', this.handleRequestPut.bind(this));
    //this.app.put(this.route+'/*', this.handleRequestPut.bind(this));
    //this.app.delete(this.route +':path', this.handleRequestDelete.bind(this));
    //this.app.get(this.route, this.handleRequestList.bind(this));
  }

  start() {
    if (this.server) {
      throw new Error('Server is already running');
    }

    this.server = this.app.listen(this.config.port);


    return e2p(this.server, 'listening').then(() => {
      this.connection = this.server.address();
      //this.url = `http://${getLocalIpAddress()}:${this.connection.port}`;
      this.url = `http://localhost:${this.connection.port}`;
      console.log('given url : ', this.url);
      return this.server;
    })
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.connection = null;
    }
  }

  private async handleRequestAll(request, response) {
    // parsing the path and the request parameters
    request.url = (decodeURIComponent(request.url));
    var str2 = this.route.slice(0, -1) + '';

    const temp = request.url.split(str2);
    if (request.query.prefix !== undefined)
      request.params.path = join(request.query.prefix, temp[0]);
    else {
      if (temp[1] !== undefined)
        request.params.path = temp[1].split('?')[0];
      else // change for IOS as no bucket name is present in the original url
        request.params.path = temp[0].split('?')[0];
    }
    // if no prefix is provided
    if(request.params.path === '/'){
      request.params.path = '';
    }
    console.log("path", request.params.path);

    console.log("request", request.method);

    if (request.method === 'PUT') {
      this.handleRequestPut(request, response);
    }

    if (request.method === 'POST') {
      this.handleRequestPost(request, response);
    }

    if (request.method === 'GET') {
      if (request.params.path.indexOf('.') === -1) {
        this.handleRequestList(request, response);
      }
      else {
        this.handleRequestGet(request, response);
      }
    }
    if (request.method === 'DELETE') {
      this.handleRequestDelete(request, response);
    }
  }

  private async handleRequestGet(request, response) {
    // fill in  this content
    console.log("enter get");
    const filePath = join(this.localDirectoryPath, request.params.path);
    if (existsSync(filePath)) {
      readFile(filePath, (err, data) => {
        if (err){
          console.log("error");
        }
        response.send(data);
      });
    }
    else{
      response.status(404);
      response.send(o2x({
        '?xml version="1.0" encoding="utf-8"?': null,
        Error: {
          "Code"     : "NoSuchKey",
          "Message"  : "The specified key does not exist.",
          "Key"      : request.params.path,
          "RequestId": "",
          "HostId"   : ""
        }
      }));
    }
  }

  private async handleRequestList(request, response) {
    // fill in  this content
    console.log("enter list");
    let ListBucketResult = {};
    let key1 = 'Contents';
    ListBucketResult[key1] = [];

    let commonPrefixes = {};
    let key2 = 'CommonPrefixes';
    ListBucketResult[key2] = [];

    let maxKeys;
    let prefix = request.query.prefix || '';
    if(request.query.maxKeys !== undefined){
       maxKeys = Math.min(request.query.maxKeys,1000);
    }
    else{
      maxKeys = 1000;
    }
    let delimiter = request.query.delimiter || '';
    let startAfter = request.query.startAfter || '';
    let keyCount = 0;
    // getting folders recursively
    const dirPath = normalize(join(this.localDirectoryPath, request.params.path) + '/');
    //console.log("dirPath", dirPath);
    let files = glob.sync(dirPath + '/**/*');
    for (let file in files) {
      if(delimiter !== '' && checkfile(file,prefix,delimiter)){
        ListBucketResult[key2].push({
          'prefix' :  request.params.path + files[file].split(dirPath)[1]
        });
      }
      if (!statSync(files[file]).isDirectory()) {
        if(keyCount === maxKeys){
          break;
        }

        ListBucketResult[key1].push({
          "Key"          : request.params.path + files[file].split(dirPath)[1],
          "LastModified" : new Date(statSync(files[file]).mtime).toISOString(),
          "Size"         : statSync(files[file]).size,
          "ETag"         : etag(files[file]),
          "StorageClass" : 'STANDARD'
        });
        //console.log(request.params.path + files[file].split(dirPath)[1]);
        keyCount = keyCount +1 ;
      }
    }
    ListBucketResult["Name"] = this.route.split('/')[1];
    ListBucketResult["Prefix"] = request.query.prefix || '';
    ListBucketResult["KeyCount"] =  keyCount;
    ListBucketResult["MaxKeys"]  = maxKeys;
    ListBucketResult["Delimiter"] = delimiter;
    if(keyCount === maxKeys){
      ListBucketResult["IsTruncated"] =  true;
    }
    else{
      ListBucketResult["IsTruncated"] =  false;
    }
    response.set('Content-Type', 'text/xml');
    response.send(o2x({
      '?xml version="1.0" encoding="utf-8"?': null,
      ListBucketResult
    }));
  }

  private async handleRequestDelete(request, response) {
    // fill in  this content
    console.log("enter delete");
    const filePath = join(this.localDirectoryPath, request.params.path);
    if(existsSync(filePath)){
      unlink(filePath, (err) => {
        if (err) throw err;
        response.send(xml(convert.json2xml(JSON.stringify(request.params.id + 'was deleted'))));
      });
    }
    else{
      response.sendStatus(204);
    }
  }

  private async handleRequestPut(request, response) {
    // fill in  this content
    console.log("put entered");
    const directoryPath = join(String(this.localDirectoryPath), String(request.params.path));
    ensureFileSync(directoryPath);
    var new_data = stripChunkSignaturev2(request.body);
    writeFileSync(directoryPath, new_data);
    response.send(xml(convert.json2xml(JSON.stringify('upload success'))));
  }
  private async handleRequestPost(request, response) {
    // fill in  this content
    console.log("post entered");
    const directoryPath = join(String(this.localDirectoryPath), String(request.params.path));

    if (request.query.uploads !== undefined) {
      this.uploadId = uuid();
      //response.set('Content-Type', 'text/xml');
      response.send(o2x({
        '?xml version="1.0" encoding="utf-8"?': null,
        InitiateMultipartUploadResult: {
          "Bucket": this.route,
          "Key": request.params.path,
          "UploadId": this.uploadId
        }
      }));
    }
    if (request.query.uploadId === this.uploadId) {
      response.set('Content-Type', 'text/xml');
      response.send(o2x({
        '?xml version="1.0" encoding="utf-8"?': null,
        CompleteMultipartUploadResult: {
          "Location": request.url,
          "Bucket": this.route,
          "Key": request.params.path,
          "Etag": etag(directoryPath) 
        }
      }));
    }
  }
}

// removing chunk siognature from request payload if present
function stripChunkSignaturev2(buf: Buffer) {
  let str = buf.toString();
  var regex1 = /^[A-Fa-f0-9]+;chunk-signature=[0-9a-f]{64}/gm;
  let m;
  let offset = [];
  let chunk_size = [];
  let arr = [];
  while ((m = regex1.exec(str)) !== null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === regex1.lastIndex) {
      regex1.lastIndex++;
    }
    m.forEach((match, groupIndex, index) => {
      offset.push(Buffer.from(match).byteLength);
      var temp = match.split(';')[0];
      chunk_size.push(parseInt(temp, 16));
      console.log(`Found match, group ${groupIndex}: ${match}`);
    });
  }
  var start = 0;
  //console.log('chunk_size', chunk_size);
  //console.log('offet', offset);

  //if no chunk signature is present
  if(offset.length === 0){
    return buf;
  }
  for (let i = 0; i < offset.length - 1; i++) {
    //console.log("i = ", i);
    start = start + offset[i] + 2;
    //console.log("start= ", start);
    arr.push(buf.slice(start, start + chunk_size[i]));
    start = start + chunk_size[i] + 2;
  }
  return Buffer.concat(arr);
}

// check for the delimiter in the file for list object request
function checkfile(file : String ,prefix : String , delimiter : String){

  if(delimiter === ''){
    return true;
  }
  else{
    const temp = file.split(String(prefix))[1].split(String(delimiter));
    //console.log("temp",temp);
    if(temp[1] === undefined){
      return false;
    }
    else{
      return true;
    }
  }
}
