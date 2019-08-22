var parser = require('xml2json');
var builder = require('xmlbuilder');
const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');
var WooCommerceAPI = require('woocommerce-api');
var nodemailer = require('nodemailer');

var SFTPClient = require('sftp-promises');

var bleckmannDir = "LIVE"; //change to LIVE or TEST

var sftpConfig = {
    host: 'sftp.be.bleckmann.com',
    port: '22',
    username: 'WONDERBUCKLE',
    password: '####',
    readyTimeout: 99999
};

var options = {
    object: true,
    reversible: false,
    coerce: false,
    sanitize: true,
    trim: true,
    arrayNotation: false,
    alternateTextNode: false
};

var transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'wonderbuckle.bleckmann@gmail.com',
      pass: '####'
    }
});
  
var mailOptions = {
    from: 'wonderbuckle.bleckmann@gmail.com',
    to: 'robin@gafas.be',
    subject: 'Connection with Bleckmann failed',
    text: ''
};

const app = express();

var WooCommerce = new WooCommerceAPI({
    url: 'https://wonderbuckle.com',
    consumerKey: 'CK_KEY',
    consumerSecret: 'CS_KEY',
    wpAPI: true,
    version: 'wc/v3'
});


var sftpProm = new SFTPClient(sftpConfig);

const renameFile = (fileName) => {
    sftpProm.mv("/"+bleckmannDir+"/OUT/"+fileName, "/"+bleckmannDir+"/OUT_ARCHIVE/"+fileName).then(()=>{
        //console.log("file moved");
        return;
    }).catch((err) => {
        console.log(err, 'catch error move file out to out_archive');
    });
}

const getOutData = (data) =>{
    data.forEach(file => {
        sftpProm.getBuffer('/'+bleckmannDir+'/OUT/'+file.filename).then((chunk) => {
            var xml_data = chunk.toString('utf8');
            //console.log(xml_data);

            if(file.filename.includes("stdctnext")||file.filename.includes("STDCTNEXT")){
                updateOrderDataWC(xml_data);
            }
            if(file.filename.includes("stdstoext")||file.filename.includes("STDSTOEXT")){
                updateStockWC(xml_data);
            }

            renameFile(file.filename);
            
            return("done");
        }).catch((err)=>{
            console.log("error get file:", err)
        });
    });
}

const updateOrderDataWC = (xml) => {
    var json = parser.toJson(xml, options);
    var trackingNumber = json['ns0:CTN'].Header.Containers.Trackingnumber;
    var carrier = json['ns0:CTN'].Header.Carrier_ID;
    var trackingLink = "";
    if(carrier === "GLSBELGIUM"){
        trackingLink = "https://gls-group.eu/BE/en/track-trace?match="+trackingNumber;
    } else if(carrier === "DHLINT"){
        trackingLink = "http://www.dhl.co.uk/content/gb/en/express/tracking.shtml?AWB="+trackingNumber+"&brand=DHL";
    } else if(carrier === "IPCARCEL"){
        trackingLink = "https://tracking.i-parcel.com/?TrackingNumber="+trackingNumber;
    }
    putTrackingToWC(json['ns0:CTN'].Header.Order_ID, trackingNumber, carrier, json['ns0:CTN'].Header.Shipped_Date, trackingLink);
}

const updateStockWC = (xml) =>{
    var json = parser.toJson(xml, options);
    var updateData = {
        create: [],
        update: [],
        delete: []
    }
    json['STO'].Inventory.forEach(inventory => {
        var productId = inventory.SKU_ID.substring(0, inventory.SKU_ID.indexOf('-'));
        var singleProduct;
        if(parseInt(inventory.QTY_Free) > 5 ){
            singleProduct = {
                id: productId,
                stock_quantity: parseInt(inventory.QTY_Free),
                stock_status: "instock"
            };
        }else{
            singleProduct = {
                id: productId,
                stock_quantity: 0,
                stock_status: "outofstock"
            };
        }
        //console.log(singleProduct);
        updateData.update.push(singleProduct);
        
    });
    console.log(updateData);
    putStockToWC(updateData);
    //putStockToWC(productId, inventory.QTY_Free);
}

const putStockToWC = (/*sku, qty*/data) =>{
    /*var data;
    if(qty > 5 ){
        data = {
            stock_quantity: qty,
            stock_status: "instock"
        };
    }else{
        data = {
            stock_quantity: 0,
            stock_status: "outofstock"
        };
    }*/
    
    WooCommerce.put("products/batch", data, (err, data, res) => {
        if(err) console.log(err, 'catch error put products');
        //console.log("stock updated");
        console.log(res);
    });
}

const putTrackingToWC = (orderId, trackingNumber, carrier, date, link) => {
    var data = {
        status: "completed",
        meta_data: [
            {
                key: "ywot_tracking_code",
                value: trackingNumber
            },
            {
                key: "ywot_pick_up_date",
                value: date
            },
            {
                key: "ywot_carrier_name",
                value: carrier
            },
            {
                key: "ywot_picked_up",
                value: "on"
            },
            {
                key: "tracking_link",
                value: link
            }
        ]
    };
    
    WooCommerce.put("orders/"+orderId, data, (err, data, res) => {
        if(err) console.log(err, 'catch error put order');
        //console.log("tracking updated");
    });
}

const putOrdersIn = (order) => {
    //TODO: check different shipping types
    console.log("new order: "+order.id);

    var date = new Date(order.date_created).toISOString().
        replace(/T/, '').
        replace(/-/, '').
        replace(/-/, '').
        replace(/:/, '').
        replace(/:/, '').    
        replace(/\..+/, '');

    /* Generate XML */
    var dispatch_method = "STANDARD";
    if(order.shipping_lines[0].method_title === "Express"){
        dispatch_method = "EXPRESS";
    }
    var root = builder.create('dcsmergedata', {version: '1.0', encoding: 'utf-8'})
        .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
        .att('xsi:noNamespaceSchemaLocation', '../lib/interface_order_header.xsd')
        .ele('dataheaders')
        .ele('dataheader', {'transaction':'add'})
        .ele('address1', order.shipping.address_1).up()
        .ele('address2', order.shipping.address_2).up()
        .ele('client_id', 'WONDERBUCK').up()
        .ele('contact_email', order.billing.email).up()
        .ele('contact_phone', order.billing.phone).up()
        .ele('country', order.shipping.country).up()
        .ele('customer_id', order.customer_id).up()
        .ele('dispatch_method', dispatch_method).up()
        .ele('freight_terms', dispatch_method).up()
        .ele('from_site_id', 'KH').up()
        .ele('instructions', order.customer_note).up()
        .ele('name', order.shipping.first_name + " " + order.shipping.last_name).up()
        .ele('order_date', date).up()
        .ele('order_id', order.id).up()
        .ele('owner_id', '01').up()
        .ele('postcode', order.shipping.postcode).up()
        .ele('town', order.shipping.city).up()
        .ele('datalines');
    order.line_items.forEach((line_item, index) => {
        if(line_item.meta_data[0].key === "bracelet_sku"){
            var lineNote = builder.create('dataline').att('transaction','add')
                .ele('client_id', 'WONDERBUCK').up()
                .ele('condition_id', 'OK1').up()
                .ele('line_id', index+1).up()
                .ele('order_id', order.id).up()
                .ele('product_currency', order.currency).up()
                .ele('product_price', line_item.price).up()
                .ele('qty_ordered', line_item.quantity).up()
                .ele('sku_id', line_item.sku).up()
                .ele('user_def_note_2', line_item.meta_data[0].value).up();
            root.importDocument(lineNote);
        } else {
            var line = builder.create('dataline').att('transaction','add')
                .ele('client_id', 'WONDERBUCK').up()
                .ele('condition_id', 'OK1').up()
                .ele('line_id', index+1).up()
                .ele('order_id', order.id).up()
                .ele('product_currency', order.currency).up()
                .ele('product_price', line_item.price).up()
                .ele('qty_ordered', line_item.quantity).up()
                .ele('sku_id', line_item.sku).up();
            root.importDocument(line);
        }
    });
    
    var xml = root.end({ pretty: true});

    /* Upload XML to FTP as buffer */
    var dataBuffer = Buffer.from(xml);

    return sftpProm.putBuffer(dataBuffer, "/"+bleckmannDir+"/IN/WONDERBUCK_ORD_IN_"+date+".xml").then((res) => {
        console.log("sftpProm was: " + res);
        var result;
        if(res){
            console.log("order #"+order.id+" is uploaded to Bleckmann");
            result = true;
            return sftpProm.putBuffer(dataBuffer, "/TEST/OUT/WONDERBUCK_ORD_IN_"+date+".xml")
        }
        if(!res){
            console.error('Failed to upload order: '+order.id);
            mailOptions.text = 'Failed to upload order: '+order.id;
            result = false;
            transporter.sendMail(mailOptions, (error, info)=>{
                if (error) {
                    console.log("Email error: ", error);
                    return false;
                } else {
                    console.log('Email sent: ' + info.response);
                    return true;
                }
            });
            return false;
        }
        return result;
    }).catch((err)=>{
        mailOptions.text = 'Failed to upload order: '+order.id;
        transporter.sendMail(mailOptions, (error, info)=>{
            if (error) {
                console.log("Email error: ", error);
                return;
            } else {
                console.log('Email sent: ' + info.response);
                return;
            }
        });
        console.error('Failed to upload order: '+order.id);
        console.error(err);
    });

}

/* Firebase Functions for REST API call */
app.use(cors({ origin: true }));

// build multiple CRUD interfaces:
//app.get('/:id', (req, res) => res.send(Widgets.getById(req.params.id)));
app.post('/', (req, res) => {
    console.log(req.body);
    if(req.body.status === "processing"){
        putOrdersIn(req.body);
    }
    res.send();
});

const ListOutFolder = () => {
    sftpProm.ls('/'+bleckmannDir+'/OUT/').then((data) => {
        console.log(data);
        if(data.entries.length>0){
            console.log("data to update. Files to update: "+data.entries.length);
            getOutData(data.entries);
        }
        return("done");
    }).catch((err) => {
        console.error(err, 'catch error FTP prom connection schedule');
    });
    return("done");
}

exports.order = functions.https.onRequest(app);

exports.scheduledFunction = functions.pubsub.schedule('every 30 minutes').onRun((context) => {
    return ListOutFolder();
});