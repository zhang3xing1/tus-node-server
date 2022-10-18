import 'should'

import {strict as assert} from 'node:assert'
import http from 'node:http'

import request from 'supertest'

import Server from '../lib/Server'
import FileStore from '../lib/stores/FileStore'
import DataStore from '../lib/stores/DataStore'
import {TUS_RESUMABLE, EVENTS} from '../lib/constants'

const hasHeader = (res: any, header: any) => {
  const key = Object.keys(header)[0]
  return res._header.includes(`${key}: ${header[key]}`)
}

describe('Server', () => {
  describe('instantiation', () => {
    it('constructor must require options', () => {
      assert.throws(() => {
        // @ts-expect-error missing argument
        new Server()
      }, Error)
      assert.throws(() => {
        new Server({})
      }, Error)
    })

    it('should accept valid options', () => {
      assert.doesNotThrow(() => {
        new Server({path: '/files'})
      })
      assert.doesNotThrow(() => {
        new Server({
          path: '/files',
          namingFunction() {
            return '1234'
          },
        })
      })
    })

    it('should throw on invalid namingFunction', () => {
      assert.throws(() => {
        const server = new Server({path: '/files', namingFunction: '1234'})
        server.datastore = new DataStore()
      }, Error)
    })

    it('setting the DataStore should attach handlers', (done: any) => {
      const server = new Server({path: '/files'})
      server.handlers.should.be.empty()
      server.datastore = new DataStore()
      server.handlers.should.have.property('HEAD')
      server.handlers.should.have.property('OPTIONS')
      server.handlers.should.have.property('POST')
      server.handlers.should.have.property('PATCH')
      server.handlers.should.have.property('DELETE')
      done()
    })
  })

  describe('listen', () => {
    let server: any

    before(() => {
      server = new Server({path: '/test/output'})
      server.datastore = new DataStore()
    })

    it('should create an instance of http.Server', (done: any) => {
      const new_server = server.listen()
      assert.equal(new_server instanceof http.Server, true)
      new_server.close()
      done()
    })
  })

  describe('get', () => {
    let server
    let listener: any

    before(() => {
      server = new Server({path: '/test/output'})
      server.datastore = new DataStore()
      server.get('/some_url', (req: any, res: any) => {
        res.writeHead(200)
        res.write('Hello world!\n')
        res.end()
      })
      listener = server.listen()
    })

    after(() => {
      listener.close()
    })

    it('should respond to user implemented GET requests', (done: any) => {
      request(listener).get('/some_url').expect(200, 'Hello world!\n', done)
    })

    it('should 404 non-user implemented GET requests', (done: any) => {
      request(listener).get('/not_here').expect(404, {}, done)
    })
  })

  describe('handle', () => {
    let server: any
    let listener: any

    before(() => {
      server = new Server({path: '/test/output'})
      server.datastore = new FileStore({
        directory: './test/output',
      })
      listener = server.listen()
    })

    after(() => {
      listener.close()
    })

    it('should 412 !OPTIONS requests without the Tus header', (done: any) => {
      request(listener).post('/').expect(412, 'Tus-Resumable Required\n', done)
    })

    it('OPTIONS should return configuration', (done: any) => {
      request(listener)
        .options('/')
        .expect(204, '', (err: any, res: any) => {
          res.headers.should.have.property('access-control-allow-methods')
          res.headers.should.have.property('access-control-allow-headers')
          res.headers.should.have.property('access-control-max-age')
          res.headers.should.have.property('tus-resumable')
          res.headers['tus-resumable'].should.equal(TUS_RESUMABLE)
          done(err)
        })
    })

    it('HEAD should 404 non files', (done: any) => {
      request(listener)
        .head('/')
        .set('Tus-Resumable', TUS_RESUMABLE)
        .expect(404, {}, done)
    })

    it('POST should require Upload-Length header', (done: any) => {
      request(listener)
        .post(server.options.path)
        .set('Tus-Resumable', TUS_RESUMABLE)
        .expect(400, {}, done)
    })

    it('POST should require non negative Upload-Length number', (done: any) => {
      request(listener)
        .post(server.options.path)
        .set('Tus-Resumable', TUS_RESUMABLE)
        .set('Upload-Length', '-3')
        .expect(400, 'Invalid upload-length\n', done)
    })

    it('POST should validate the metadata header', (done: any) => {
      request(listener)
        .post(server.options.path)
        .set('Tus-Resumable', TUS_RESUMABLE)
        .set('Upload-Metadata', '')
        .expect(400, 'Invalid upload-metadata\n', done)
    })

    it('DELETE should return 404 when file does not exist', (done: any) => {
      request(server.listen())
        .delete(`${server.options.path}/123`)
        .set('Tus-Resumable', TUS_RESUMABLE)
        .expect(404, 'The file for this url was not found\n', done)
    })

    it('DELETE should return 404 on invalid paths', (done: any) => {
      request(server.listen())
        .delete('/this/is/wrong/123')
        .set('Tus-Resumable', TUS_RESUMABLE)
        .expect(404, 'The file for this url was not found\n', done)
    })

    it('DELETE should return 204 on proper deletion', (done: any) => {
      request(server.listen())
        .post(server.options.path)
        .set('Tus-Resumable', TUS_RESUMABLE)
        .set('Upload-Length', '12345678')
        .then((res: any) => {
          request(server.listen())
            .delete(res.headers.location)
            .set('Tus-Resumable', TUS_RESUMABLE)
            .expect(204, done)
        })

      it('POST should ignore invalid Content-Type header', (done: any) => {
        request(listener)
          .post(server.options.path)
          .set('Tus-Resumable', TUS_RESUMABLE)
          .set('Upload-Length', '300')
          .set('Upload-Metadata', 'foo aGVsbG8=, bar d29ynGQ=')
          .set('Content-Type', 'application/false')
          .expect(201, {}, (err: any, res: any) => {
            res.headers.should.have.property('location')
            done(err)
          })
      })

      it('should 404 other requests', (done: any) => {
        request(listener)
          .get('/')
          .set('Tus-Resumable', TUS_RESUMABLE)
          .expect(404, {}, done)
      })

      it('should allow overriding the HTTP method', (done: any) => {
        const req = {
          headers: {'x-http-method-override': 'OPTIONS'},
          method: 'GET',
        }
        // @ts-expect-error todo
        const res = new http.ServerResponse({method: 'OPTIONS'})
        server.handle(req, res)
        assert.equal(req.method, 'OPTIONS')
        done()
      })

      it('should allow overriding the HTTP method', (done: any) => {
        const origin = 'vimeo.com'
        const req = {headers: {origin}, method: 'OPTIONS', url: '/'}
        // @ts-expect-error todo
        const res = new http.ServerResponse({method: 'OPTIONS'})
        server.handle(req, res)
        assert.equal(
          hasHeader(res, {
            'Access-Control-Allow-Origin': origin,
          }),
          true
        )
        done()
      })
    })

    describe('hooks', () => {
      let server: any
      let listener: any

      beforeEach(() => {
        server = new Server({path: '/test/output'})
        server.datastore = new FileStore({
          directory: './test/output',
        })
        listener = server.listen()
      })

      afterEach(() => {
        listener.close()
      })

      it('should fire when an endpoint is created', (done: any) => {
        server.on(EVENTS.EVENT_ENDPOINT_CREATED, (event: any) => {
          event.should.have.property('url')
          done()
        })
        request(listener)
          .post(server.options.path)
          .set('Tus-Resumable', TUS_RESUMABLE)
          .set('Upload-Length', '12345678')
          .end((err: any) => {
            if (err) {
              done(err)
            }
          })
      })

      it('should fire when a file is created', (done: any) => {
        server.on(EVENTS.EVENT_FILE_CREATED, (event: any) => {
          event.should.have.property('file')
          done()
        })
        request(listener)
          .post(server.options.path)
          .set('Tus-Resumable', TUS_RESUMABLE)
          .set('Upload-Length', '12345678')
          .end((err: any) => {
            if (err) {
              done(err)
            }
          })
      })

      it('should fire when a file is deleted', (done: any) => {
        server.on(EVENTS.EVENT_FILE_DELETED, (event: any) => {
          event.should.have.property('file_id')
          done()
        })
        request(server.listen())
          .post(server.options.path)
          .set('Tus-Resumable', TUS_RESUMABLE)
          .set('Upload-Length', '12345678')
          .then((res: any) => {
            request(server.listen())
              .delete(res.headers.location)
              .set('Tus-Resumable', TUS_RESUMABLE)
              .end((err: any) => {
                if (err) {
                  done(err)
                }
              })
          })
      })

      it('should fire when an upload is finished', (done: any) => {
        server.on(EVENTS.EVENT_UPLOAD_COMPLETE, (event: any) => {
          event.should.have.property('file')
          done()
        })
        request(server.listen())
          .post(server.options.path)
          .set('Tus-Resumable', TUS_RESUMABLE)
          .set('Upload-Length', Buffer.byteLength('test', 'utf8').toString())
          .then((res) => {
            request(server.listen())
              .patch(res.headers.location)
              .send('test')
              .set('Tus-Resumable', TUS_RESUMABLE)
              .set('Upload-Offset', '0')
              .set('Content-Type', 'application/offset+octet-stream')
              .end((err) => {
                if (err) {
                  done(err)
                }
              })
          })
      })

      it('should fire when an upload is finished with upload-defer-length', (done: any) => {
        server.on(EVENTS.EVENT_UPLOAD_COMPLETE, (event: any) => {
          event.should.have.property('file')
          done()
        })
        request(server.listen())
          .post(server.options.path)
          .set('Tus-Resumable', TUS_RESUMABLE)
          .set('Upload-Defer-Length', '1')
          .then((res) => {
            request(server.listen())
              .patch(res.headers.location)
              .send('test')
              .set('Tus-Resumable', TUS_RESUMABLE)
              .set('Upload-Offset', '0')
              .set('Upload-Length', Buffer.byteLength('test', 'utf8').toString())
              .set('Content-Type', 'application/offset+octet-stream')
              .end((err) => {
                if (err) {
                  done(err)
                }
              })
          })
      })
    })
  })
})